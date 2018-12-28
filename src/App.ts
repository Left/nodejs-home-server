import * as express from 'express'
import * as http from 'http';
import * as WebSocket from 'ws';
import * as stream from "stream";
import * as fs from "fs";
import * as child_process from "child_process";
import * as dgram from "dgram";
import * as events from "events";

var BBPromise = require('bluebird')
var adbkit = require('adbkit')

var client = adbkit.createClient()

function trace<T>(x: T): T {
    console.log(x);
    return x;
}

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
            }, 6000);
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
            setTimeout(() => this.attemptToConnect(), 3000);
        });

        this.ws.on('close', (code: number, reason: string) => {
            console.log("Closed: " + code + " " + reason);
            this.dropConnection();
            setTimeout(() => this.attemptToConnect(), 3000);
        });
    }

    public toString() : string { return this.name + "(" + this.ip + ")"; }

    private wasRecentlyContacted() {
        return Date.now() - this.lastResponse < 10000;
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

interface Property<T> {
    readonly name: string;
    available(): boolean;
    get(): T;
    onChange(fn: () => void): void;
}

interface WriteableProperty<T> extends Property<T> {
    set(val: T): void;
}

function isWriteableProperty<T>(object: Property<T>): object is WriteableProperty<T> {
    return 'set' in object;
}

interface Controller {
    name: string;
    properties: Property<any>[];
}

abstract class PropertyImpl<T> implements Property<T> {
    protected evs: events.EventEmitter = new events.EventEmitter();
    private _val: T;

    available(): boolean {
        return true;
    }

    get(): T {
        return this._val;
    }

    protected setInternal(val: T) {
        this._val = val;
        this.fireOnChange();
    }

    constructor(public readonly name: string, readonly initial) {
        this._val = initial;
    }

    onChange(fn: () => void): void {
        // TODO: Impl me
        this.evs.on('change', fn);
    }

    protected fireOnChange() {
        this.evs.emit('change');
    }
}

abstract class WriteblePropertyImpl<T> extends PropertyImpl<T> implements WriteableProperty<T> {
    constructor(public readonly name: string, readonly initial) {
        super(name, initial);
    }

    abstract set(val: T): void;
} 


abstract class Relay extends WriteblePropertyImpl<boolean> {
    constructor(readonly name) {
        super(name, false);
    }

    public abstract switch(on: boolean): Promise<void>;

    set(val: boolean): void {
        this.switch(val).then(() => {
            this.setInternal(val);
        })
        .catch(() => {
            // Nothing has changed, but we fire an eent anyway
            this.fireOnChange();
        });
    }
}

function runShell(cmd: string, args: string[]): Promise<String> {
    return new Promise<String>((accept, reject) => {
        const out = [];
        const pr = child_process.spawn(cmd, args);
        pr.on('error', (err: Error) => {
            reject(err);
        })
        pr.on('close', () => {
            accept(out.join(''));
        });
        pr.stdout.on("data", (d) => {
            out.push(d.toString());
        });
    
    });
}

class GPIORelay extends Relay {
    private _init: Promise<void>;

    constructor(readonly name: string, public readonly pin: number) { 
        super(name); 

        this._init = runShell("/root/WiringOP/gpio/gpio", ["-1", "mode", "" + this.pin, "out"])
            .then(() => {
                return runShell("/root/WiringOP/gpio/gpio", ["-1", "read", "" + this.pin])
                    .then((str) => {
                        this.setInternal(str.startsWith("0"));
                        return void 0;
                    })

            })
    }

    switch(on: boolean): Promise<void> {
        // console.log("Here ", on);
        return this._init.then(() => {
            return runShell("/root/WiringOP/gpio/gpio", ["-1", "write", "" + this.pin, on ? "0" : "1"])
                .then(() => this.setInternal(on));
        });
    }
}
class ControllerRelay extends Relay {
    constructor(
        readonly name: string, 
        public readonly controller: ChildController,
        public readonly index: number) {
        super(name);
    }

    switch(on: boolean): Promise<void> {
        if (this.controller.isAlive()) {
            return this.controller.send({
                type: "switch", 
                id: "" + this.index,
                on: on ? "true" : "false"
            });
        } else {
            return Promise.reject('Controller is not connected')
        }
    }
}

class MiLightBulb implements Controller {
    readonly name = "MiLight";
    readonly properties: Property<any>[] = [
        new (class MiLightBulbRelay extends WriteblePropertyImpl<boolean> {
            constructor(
                readonly pThis: MiLightBulb) {
                super("On/off", false);
            }

            set(on: boolean): Promise<void> {
                if (on) {
                    return this.pThis.send([0x42, 0x00, 0x55])
                        .then(() => BBPromise.delay(100).then(
                            () => this.pThis.send([0xC2, 0x00, 0x55])
                        ));
                } else {
                    return this.pThis.send([0x46, 0x00, 0x55]);
                }
            }
        })(this),
        new (class BrightnessProperty extends WriteblePropertyImpl<number> {
            constructor(public readonly pThis: MiLightBulb) {
                super("Brightness", 50);
            }
            public set(val: number): void {
                this.pThis.send([0x4E, 0x2 + (0x15 * val / 100), 0x55])
                    .then(() => this.setInternal(val));
            }
        })(this),
        new (class BrightnessProperty extends WriteblePropertyImpl<number> {
            constructor(public readonly pThis: MiLightBulb) {
                super("Hue", 50);
            }
            public set(val: number): void {
                this.pThis.send([0x40, (0xff * val / 100), 0x55])
                    .then(() => this.setInternal(val));
            }
        })(this)
    ];

    private send(buf: number[]): Promise<void> {
        const sock = dgram.createSocket("udp4");
        return new Promise<void>((accept, reject) => {
            sock.send(
                new Buffer(buf), 
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

class TabletOnOffRelay extends Relay {
    constructor(private readonly tbl: Tablet) {
        super(tbl.id + " on/off");
    }

    public switch(on: boolean): Promise<void> {
        this.tbl.adbStream.write("input keyevent KEYCODE_POWER\n");
        this.tbl.adbStream.write("dumpsys power\n");
        this.tbl.adbStream.on('data', data => {
            console.log(data);
        });
        return Promise.resolve(void 0);

    }
}


class Tablet implements Controller {
    constructor(public readonly id: string) {
    }

    public adbStream: NodeJS.ReadWriteStream;
    public name: string;

    public properties = [
        new TabletOnOffRelay(this)
    ]

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

    private roomsClock: ChildController = new ChildController("192.168.121.75", "RoomsClock", this);
    private kitchenClock: ChildController = new ChildController("192.168.121.131", "KitchenClock", this)

    private r1 = new GPIORelay("Лампа на шкафу", 38);
    private r2 = new GPIORelay("Колонки", 40);
    private r3 = new GPIORelay("Освещение в коридоре", 36);
    private r4 = new GPIORelay("Потолок в комнате", 32);
    private ctrlGPIO = {
        name: "Комната",
        properties: [this.r1, this.r2, this.r3, this.r4]
    }
    
    private r5 = new ControllerRelay("Потолок на кухне", this.kitchenClock, 0);
    private r6 = new ControllerRelay("Лента на кухне", this.kitchenClock, 1);
    private ctrlKitchen = {
        name: "Часы на кухне",
        properties: [this.r5, this.r6]
    }

    private tempProperty = new (class Temp extends PropertyImpl<string> {
        constructor() {
            super("Температура", "Нет данных")
        }
    })();

    private ctrlClock = {
        name: "Часы и датчик температуры",
        properties: [ this.tempProperty ]
    }

    private ctrlLamp = new MiLightBulb();

    private readonly kindle: Tablet = new Tablet('192.168.121.166:5556');
    private readonly nexus7: Tablet = new Tablet('00eaadb6');

    private readonly tablets: Map<string, Tablet> = new Map();

    private readonly controllers: Controller[] = [ 
        this.ctrlGPIO, 
        this.ctrlClock,
        this.ctrlKitchen, 
        this.ctrlLamp, 
        this.kindle, 
        this.nexus7 
    ];

    private saveConf() {
        fs.writeFileSync('/root/storedConf.json', JSON.stringify(this.config));
    }

    constructor() {
        this.expressApi = express();

        this.tablets.set(this.kindle.id, this.kindle);
        this.tablets.set(this.nexus7.id, this.nexus7);

        if (fs.existsSync('/root/storedConf.json')) {
            const data = fs.readFileSync('/root/storedConf.json');
            this.config = JSON.parse(data.toString());
        } else {
            this.config = emptyConfig;
        }

        this.server = http.createServer(this.expressApi);

        this.wss = new WebSocket.Server({ server: this.server });
        this.wss.on('connection', (ws: WebSocket) => {
            //connection is up, let's add a simple simple event
            ws.on('message', (message: string) => {
                const msg = JSON.parse(message);
                if (msg.type === "setProp") {
                    const prop = this.controllers[msg.controller].properties[msg.prop];
                    if (isWriteableProperty(prop)) {
                        prop.set(msg.val);
                    } else {
                        console.error(`Property ${prop.name} is not writable`);
                    }
                } else {
                    //log the received message and send it back to the client
                    console.log('received: %s', message);
                }
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
        router.get('/tablets', (req, res) => {
            res.json(Array.from(this.tablets.values()).map(d => { return { 
                id: d.id, 
                name: d.name
            }}));
        });
        router.get('/index.html', (req, res) => {
            res.contentType('html');
            res.send(this.renderToHTML());
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
                    this.processDevice(dev);
                    // console.log(this.devices.map(d => d.id).join(", "));
                });
                tracker.on('remove', (dev: adbkit.Device) => {
                    // console.log("=== REMOVED = " + dev.id);
                    // console.log(this.devices.map(d => d.id).join(", "));
                });
            });
        
        client.listDevices()
            .then((devices: adbkit.Device[]) => {
                devices.forEach(dev => {
                    this.processDevice(dev);
                });
            })
            .catch((err: Error) => {
                console.error('Something went wrong:', err.stack)
            })
        
    }
    
    private renderToHTML(): string {
        let idx = 0;

        const wrap = (tag, body) => {
            if (typeof tag == "string") {
                return `<${tag}>\n${body}\n</${tag}>`;
            } else {
                const props = Object.getOwnPropertyNames(tag[1]).map(pn => pn + "=\"" + tag[1][pn] + "\"");
                return `<${tag[0]} ${props.join(" ")}>\n${body}\n</${tag[0]}>`;
            }
        } 

        const hdr = [
            wrap(["script", {type: "text/javascript"}], 
            `
            var sock = new WebSocket("ws:/" + location.host);
            sock.onopen = () => {
                console.log("socket.onopen");
                sock.onmessage = function(event) {
                    console.log(event.data);
                    const d = JSON.parse(event.data);
                    if (d.type === 'onPropChanged') {
                        if (typeof(d.val) == "boolean") {
                            document.getElementById(d.id).checked = d.val;
                        } else if (typeof(d.val) == "number") {
                            document.getElementById(d.id).value = d.val;
                        } else if (typeof(d.val) == "string") {
                            document.getElementById(d.id).value = d.val;
                        }
                    }
                };
            };
    
            function sendVal(controllerIndex, propIndex, val) {
                sock.send(JSON.stringify({ 
                    type: 'setProp',
                    controller: controllerIndex, 
                    prop: propIndex, 
                    val: val }));
            };
            `)
        ];
        return wrap(["html", { lang: "en"}], 
            wrap("head", hdr.join("\n")) + "\n" +
            wrap("body", this.controllers.map((ctrl, ctrlIndex) => {
                return ctrl.name + "<br/>" + ctrl.properties.map((prop: Property<any>, prIndex: number): string => {
                    let res = "";
                    const id = ctrlIndex + ":" + prIndex;
    
                    const val = prop.get();
                    const avail = prop.available();
                    if (typeof val === "boolean") {
                        // Boolean property, render as checkbok
                        res = `<input type="checkbox" id=${id} 
                            ${avail ? "" : "disabled"} 
                            ${val ? "checked" : ""}
                            onclick="sendVal(${ctrlIndex}, ${prIndex}, document.getElementById('${id}').checked)">${prop.name}</input>`;
                    } else if (typeof val === "number") {
                        res = `<input ${avail ? "" : "disabled"}  type="range" id="${id}" min="0" max="100" value="${val}" 
                            oninput="sendVal(${ctrlIndex}, ${prIndex}, +document.getElementById('${id}').value)">${prop.name}</input>`;
                        } else if (typeof val === "string") {
                            res = `<input ${avail ? "" : "disabled"}  type="text" id="${id}" value="${val}" 
                                oninput="sendVal(${ctrlIndex}, ${prIndex}, +document.getElementById('${id}').value)">${prop.name}</input>`;
                        } else {
                        console.log("Unknown prop type " + typeof (val));
                    }
                
                    prop.onChange(() => {
                        this.wss.clients.forEach(cl => cl.send(JSON.stringify({
                            type: "onPropChanged",
                            controller: ctrlIndex, 
                            prop: prIndex, 
                            id: id,
                            val: prop.get()
                        })));
                    });

                    return res;
                }).join("<br/>\n")
            }).join("<hr/>\n"))
        );
    }
    
    private processDevice(device: adbkit.Device): void {
        // Wait some time for device to auth...
        BBPromise.delay(1000).then(() => {
            console.log("Let's get some info about device " + device.id + " (" + device.type + ")");
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
                    this.tempProperty['setInternal'](this.currentTemp + 'C');
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