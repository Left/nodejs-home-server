import * as express from 'express'
import * as http from 'http';
import * as WebSocket from 'ws';
import * as stream from "stream";
import * as fs from "fs";
import * as child_process from "child_process";
import * as dgram from "dgram";

import * as BBPromise from 'bluebird';

var adb = require('adbkit');

var client = adb.createClient()

interface PingResult {
    result: string;
    pingid: string;
}

interface Msg {
    type: string;
    timeseq?: number;
}

interface Temp extends Msg {
    type: 'temp';
    value: number;
}

interface Log extends Msg {
    type: 'log';
    val: string;
}

interface Hello extends Msg {
    type: 'hello';
    firmware: string;
    afterRestart: number;
}

interface IRKey extends Msg {
    type: 'ir_key';
    remote: string;
    key: string;
}

interface Ping extends Msg {
    type: 'ping';
    pingid: string;
}

interface ChildControllerHandle {
    processMsg(controller: ChildController, packet: Msg): void;
    connected(controller: ChildController): void;
    disconnected(controller: ChildController): void;
}

class ChildController {
    private pingId = 0;
    private intervalId: NodeJS.Timer;
    private lastResponse = Date.now();
    private ws: WebSocket;

    constructor(
        public readonly ip: string, 
        public name: string, 
        public readonly handle: ChildControllerHandle) {
        this.attemptToConnect();
    }

    public isAlive() {
        return !!this.ws && this.wasRecentlyContacted();
    }

    public dropConnection() {
        if (!!this.ws) {
            if (this.ws.readyState == this.ws.OPEN) {
                this.ws.close();
            }
        }
        this.ws = null;
        this.handle.disconnected(this);
    }

    public send(json: {}): Promise<void> {
        const txt = JSON.stringify(json);
        console.log(this + " SEND: " + txt);
        this.ws.send(txt);
        return Promise.resolve(void 0);
    }

    public attemptToConnect() {
        if (!!this.ws)
            return; // We're already attempting to connect

        this.ws = new WebSocket('ws://' + this.ip + ":8081");

        this.ws.on('open', () => {
            // ws.send('something');
            this.handle.connected(this);
            this.lastResponse = Date.now();
            
            if (!!this.intervalId) {
                clearInterval(this.intervalId);
            }
            this.intervalId = setInterval(() => {
                if (!this.wasRecentlyContacted()) {
                    // 6 seconds passed, no repsonse. Drop the connection and re-try
                    this.dropConnection();
                    this.attemptToConnect();
                } else {
                    const pingText = JSON.stringify({ 'type': 'ping', 'pingig': "" + (this.pingId++)});
                    try {
                        if (!!this.ws) {
                            this.ws.send(pingText);
                        }
                    } catch (err) {
                        // Failed to send, got error, let's reconnect
                        this.dropConnection();
                        this.attemptToConnect();
                    }
                }
            }, 2000);
        });

        this.ws.on('message', (data) => {
            this.lastResponse = Date.now();
            if (typeof data == "string") {
                const objData = JSON.parse(data);
                if ('result' in objData) {
                    // console.log('Pong', objData.pingid);
                } else {
                    this.handle.processMsg(this, objData);
                }
            }
        });

        this.ws.on('error', (err: Error) => {
            console.log("Error: " + err);
            this.dropConnection();
            setTimeout(() => this.attemptToConnect(), 1000);
        });

        this.ws.on('close', (code: number, reason: string) => {
            console.log("Closed: " + code + " " + reason);
            this.dropConnection();
            setTimeout(() => this.attemptToConnect(), 1000);
        });
    }

    public toString() : string { return this.name + "(" + this.ip + ")"; }

    private wasRecentlyContacted() {
        return Date.now() - this.lastResponse < 6000;
    }
}

interface Time {
    readonly hours: number;
    readonly minutes: number;
}

const emptyTime: Time = { hours: -1, minutes: -1 }

interface IConfig {
    wakeAt: Time;
    sleepAt: Time;
}

const emptyConfig: IConfig = {
    wakeAt: emptyTime,
    sleepAt: emptyTime
}

namespace adbkit {
    export interface Device { 
        id: string;
        type: string;
    }
}

interface Relay {
    readonly name: string;
    isOn(): boolean;
    switch(on: boolean): Promise<void>;
}

class GPIORelay implements Relay {
    private _on: boolean = false;
    private _modeSet: boolean = false;
    constructor(public readonly name: string, public readonly pin: number) {}

    isOn(): boolean {
        return this._on;
    }

    switch(on: boolean): Promise<void> {
        return new Promise<void>((accept, reject) => {
            const go = () => {
                child_process.spawn("/root/WiringOP/gpio/gpio", ["-1", "mode", "" + this.pin, "out"])
                    .on('close', () => {
                        this._on = on;
                        accept();
                    });
            };
            if (!this._modeSet) {
                child_process.spawn("/root/WiringOP/gpio/gpio", ["-1", "write", "" + this.pin, on ? "0" : "1"])
                    .on('close', go);
            } else {
                go();
            }    
        });
    }
}
class ControllerRelay implements Relay {
    private _on: boolean = false;

    constructor(
        public readonly name: string, 
        public readonly controller: ChildController,
        public readonly index: number) {
    }

    isOn(): boolean {
        return this._on;
    }

    switch(on: boolean): Promise<void> {
        if (this.controller.isAlive()) {
            return this.controller.send({
                type: "switch", 
                id: "" + this.index,
                on: on ? "true" : "false"
            }).then(() => {
                this._on = on;
            });
        } else {
            return Promise.reject('Controller is not connected')
        }
    }
}

class MiLightBulbRelay implements Relay {
    private _on: boolean = false;
    constructor(
        public readonly name: string) {
    }

    isOn(): boolean {
        return this._on;
    }

    switch(on: boolean): Promise<void> {
        const sock = dgram.createSocket("udp4");
        return new Promise((accept, reject) => {
            sock.send(
                new Buffer([on ? 0xc2 : 0x46, 0x00, 0x55]), 
                8899, 
                "192.168.121.35", (err, bytes) => {
                    if (!!err) {
                        reject(err);
                    } else {
                        accept(void 0);
                    }
                });    
        });
    }
}

class Tablet {
    constructor(public readonly id: string) {
    }

    public adbStream: NodeJS.ReadWriteStream;
    public name: string;

    public serializable(): any{
        return {
            id: this.id, 
            name: this.name
        }
    }
}

class App implements ChildControllerHandle {
    public expressApi: express.Express;
    public server: http.Server;
    public readonly wss: WebSocket.Server;
    public currentTemp: number;
    private config: IConfig;
    private tablets: Map<string, Tablet> = new Map();

    private roomsClock: ChildController = new ChildController("192.168.121.75", "RoomsClock", this);
    private kitchenClock: ChildController = new ChildController("192.168.121.131", "KitchenClock", this)

    public controllers: ChildController[] = [ this.roomsClock, this.kitchenClock];

    private r1 = new GPIORelay("Лампа на шкафу", 38);
    private r2 = new GPIORelay("Колонки", 40);
    private r3 = new GPIORelay("Освещение в коридоре", 36);
    private r4 = new GPIORelay("Потолок в комнате", 32);
    
    private r5 = new ControllerRelay("Потолок на кухне", this.kitchenClock, 0);
    private r6 = new ControllerRelay("Лента на кухне", this.kitchenClock, 1);

    private r7 = new MiLightBulbRelay("Лампа на столе");
    
    private allRelays: Relay[] = [
        this.r1, 
        this.r2, 
        this.r3, 
        this.r4, 
        this.r5, 
        this.r6,
        this.r7
    ];

    private saveConf() {
        fs.writeFileSync('/root/storedConf.json', JSON.stringify(this.config));
    }

    constructor() {
        this.expressApi = express();

        if (fs.existsSync('/root/storedConf.json')) {
            const data = fs.readFileSync('/root/storedConf.json');
            this.config = JSON.parse(data.toString());
        } else {
            this.config = emptyConfig;
        }

        console.log('Will wake up at ' + this.config.wakeAt.hours + ':' + this.config.wakeAt.minutes);

        this.server = http.createServer(this.expressApi);

        this.wss = new WebSocket.Server({ server: this.server });
        this.wss.on('connection', (ws: WebSocket) => {
            //connection is up, let's add a simple simple event
            ws.on('message', (message: string) => {

                //log the received message and send it back to the client
                console.log('received: %s', message);
                // ws.send(`Hello, you sent -> ${message}`);
            });

            //send immediatly a feedback to the incoming connection    
            // ws.send('Hi there, I am a WebSocket server');
        });
        this.wss.on('error', (error: Error) => {
            console.log("Error! " + error.message);
        });

        const router = express.Router()

        router.use(express.static("web"));
        router.get('/', (req, res) => {
            res.redirect('/index.html');
        });
        router.get('/favicon.ico', (req, res) => {
            const favicon = new Buffer('AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////wAAAP///////////wAAAP//////AAAA/////////////////wAAAP////////////////////////////////8AAAD///////////8AAAD//////wAAAP////////////////8AAAD/////////////////////////////////AAAA////////////AAAA//////8AAAD/////////////////AAAA/////////////////////////////////wAAAP8AAAD/AAAA/wAAAP//////AAAA/////////////////wAAAP////////////////////////////////8AAAD///////////8AAAD//////wAAAP//////AAAA//////8AAAD/////////////////////////////////AAAA////////////AAAA//////8AAAD/AAAA//////8AAAD/AAAA/////////////////////////////////wAAAP///////////wAAAP//////AAAA/////////////////wAAAP//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64'); 
            res.statusCode = 200;
            res.setHeader('Content-Length', "" + favicon.length); 
            res.setHeader('Content-Type', 'image/x-icon');
            res.setHeader("Cache-Control", "public, max-age=2592000");                // expiers after a month
            res.setHeader("Expires", new Date(Date.now() + 2592000000).toUTCString());
            res.end(favicon);
        });
        router.post('/relay', (req, res) => {
            this.allRelays[req.query["index"]].switch(req.query["on"] === "true")
            .then(() => {
                res.json({
                    result: "OK"
                });
            })
            .catch((err) => {
                console.log(err);
            });
        });
        router.get('/tablets', (req, res) => {
            res.json(Array.from(this.tablets.values()).map(d => { return { 
                id: d.id, 
                name: d.name
            }}));
        });
        router.get('/index.html', (req, res) => {
            fs.readFile('templates/index.html', 'utf-8', (err, data: string) => {
                data = data
                    .replace("\"{{{tablets}}}\"", JSON.stringify(Array.from(this.tablets.values()).map(t => t.serializable())))
                    .replace("\"{{{config}}}\"", JSON.stringify(this.config))
                    .replace("<!--{{{relays}}}-->", 
                        this.allRelays.map((r, index) => {
                            return "<div><span>" + r.name + "</span><button onclick=\"switchRelay(true, " + index + ")\"> ON </button>" +
                                "<button onclick=\"switchRelay(false, " + index + ")\"> OFF </button></div>"
                        }).join('\n')
                    )
                    ;
                res.send(data);
            });
        });
        router.get('/tablet/wakeat/:h/:m', (req, res) => {
            const hours = req.params['h'];
            const mins = req.params['m'];

            this.config.wakeAt = { hours: hours, minutes: mins };
            this.saveConf();
            console.log('Will wake up at ' + hours + ':' + mins);

            res.json({
                result: 0,
                message: 'OK'
            })
        })
        this.expressApi.use('/', router);

        client.trackDevices()
            .then(tracker => {
                tracker.on('add', (dev: adbkit.Device) => {
                    // console.log("=== ADDED   = " + dev.id);
                    this.tablets.set(dev.id, new Tablet(dev.id));
                    this.processDevice(dev);
                    // console.log(this.devices.map(d => d.id).join(", "));
                });
                tracker.on('remove', (dev: adbkit.Device) => {
                    // console.log("=== REMOVED = " + dev.id);
                    this.tablets.delete(dev.id);
                    // console.log(this.devices.map(d => d.id).join(", "));
                });
            });
        /*
        client.listDevices()
            .then((devices: AdbKitDevice[]) => {
                devices.forEach(device => {
                });
            })
            .catch((err: Error) => {
                console.error('Something went wrong:', err.stack)
            })
        */
    }

    private processDevice(device: adbkit.Device): void {
        // Wait some time for device to auth...
        BBPromise.delay(1000).then(() => {
            // console.log("Let's get some info about device " + device.id + " (" + device.type + ")");
            // And then open shell
            client.getProperties(device.id).then(props => {
                this.tablets.get(device.id).name = props['ro.product.model'];
            });
            client.shell(device.id, '').then((out: NodeJS.ReadWriteStream) => {
                this.tablets.get(device.id).adbStream = out;
            });
        });
    }

    public listen(port: number, errCont) {
        this.server.listen(port, errCont);
    }

    public connected(controller: ChildController) {
        console.log(controller + " " + "Connected");
    }

    public disconnected(controller: ChildController) {
        console.log(controller + " " + "Disconnected");
    }

    public processMsg(controller: ChildController, data: Msg) {
        const objData = <Log | Temp | Hello | IRKey> data;
        switch (objData.type) {
            case 'temp':
                if (this.currentTemp != objData.value) {
                    console.log(controller + " " + "temperature: ", objData.value);
                    this.wss.clients.forEach(cl => cl.send(objData.value));
                    this.currentTemp = objData.value;
                }
                break;
            case 'log':
                console.log(controller + " " + "log: ", objData.val);
                break;
            case 'hello':
                console.log(controller + " " + "hello: ", objData.firmware, (objData.afterRestart / 1000) + " sec");
                break;
            case 'ir_key':
                console.log(controller + " " + "ir_key: ", objData.remote, objData.key);
                break;
            default:
                console.log(controller + " UNKNOWN CMD: " + objData);
        }
    }
}

export default new App()