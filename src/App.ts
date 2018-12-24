import * as express from 'express'
import * as http from 'http';
import * as WebSocket from 'ws';
import * as stream from "stream";
import * as fs from "fs";

import * as Promise from 'bluebird';
global.Promise = Promise

var adb = require('adbkit')
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
    connected(controller: ChildController);
    disconnected(controller: ChildController);
}

class ChildController {
    private pingId = 0;
    private intervalId: NodeJS.Timer;
    private lastResponse = Date.now();
    private ws: WebSocket;

    constructor(
        public readonly ip: string, 
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
                if (this.wasRecentlyContacted()) {
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

    private wasRecentlyContacted() {
        return Date.now() - this.lastResponse > 6000;
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

class App implements ChildControllerHandle {
    public expressApi: express.Express;
    public server: http.Server;
    public readonly wss: WebSocket.Server;
    public currentTemp: number;
    private config: IConfig;

    public controllers: ChildController[] = [
        new ChildController("192.168.121.75", this),
        new ChildController("192.168.121.131", this)
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
        router.get('/index.html', (req, res) => {
            res.json({
                message: 'Hello from me!'
            })
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

        client.listDevices()
            .then((devices: { id: string, type: string }[]) => {
                devices.forEach(device => {
                    client.shell(device.id, '')
                        .then((out: NodeJS.ReadWriteStream) => {
                            out.pipe(new stream.Writable({
                                write: (chunk, encoding, next) => {
                                    console.log("Received chunk:", chunk.toString());
                                    if (chunk.length > 10) {
                                        // out.write("ls\r");
                                    }
                                    next();
                                }
                            }).on('close', () => { console.log("close"); }));
                        });
                });
            })
            .catch((err: Error) => {
                console.error('Something went wrong:', err.stack)
            })
    }

    public listen(port: number, errCont) {
        this.server.listen(port, errCont);
    }

    public connected(controller: ChildController) {
        console.log("Connected controller ", controller.ip);
    }

    public disconnected(controller: ChildController) {
        console.log("Disconnected controller ", controller.ip);
    }

    public processMsg(controller: ChildController, data: Msg) {
        const objData = <Log | Temp | Hello | IRKey> data;
        switch (objData.type) {
            case 'temp':
                if (this.currentTemp != objData.value) {
                    console.log("temperature: ", objData.value);
                    this.wss.clients.forEach(cl => cl.send(objData.value));
                    this.currentTemp = objData.value;
                }
                break;
            case 'log':
                console.log("log: ", objData.val);
                break;
            case 'hello':
                console.log("hello: ", objData.firmware, objData.afterRestart);
                break;
            case 'ir_key':
                console.log("ir_key: ", objData.remote, objData.key);
                break;
            default:
                console.log(objData);
        }
    }
}

export default new App()