import * as express from 'express'
import * as http from 'http';
import * as WebSocket from 'ws';
// import * as stream from "stream";
import * as fs from "fs";
import * as child_process from "child_process";
import * as dgram from "dgram";
import * as events from "events";

function delay(time: number): Promise<void> {
    return new Promise<void>(function(resolve) { 
        setTimeout(resolve, time);
    });
 }

var adbkit = require('adbkit')
var adbClient = adbkit.createClient()

/*
function trace<T>(x: T): T {
    console.log(x);
    return x;
}

interface PingResult {
    result: string;
    pingid: string;
}
*/

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

/*
interface Ping extends Msg {
    type: 'ping';
    pingid: string;
}
*/

interface ChildControllerHandle {
    processMsg(controller: ClockController, packet: Msg): void;
    connected(controller: ClockController): void;
    disconnected(controller: ClockController): void;
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

    export interface Tracker {
        on(event: "add", listener: (dev: Device) => void): void;
        on(event: "remove", listener: (dev: Device) => void): void;
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
    readonly name: string;
    readonly online: boolean;
    readonly properties: Property<any>[];
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

    public setInternal(val: T) {
        const shouldFire = this._val != val;
        this._val = val;
        if (shouldFire) {
            this.fireOnChange();
        }
    }

    constructor(public readonly name: string, readonly initial: T) {
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

abstract class WritablePropertyImpl<T> extends PropertyImpl<T> implements WriteableProperty<T> {
    constructor(public readonly name: string, readonly initial: T) {
        super(name, initial);
    }

    abstract set(val: T): void;
} 


abstract class Relay extends WritablePropertyImpl<boolean> {
    constructor(readonly name: string) {
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
        const out: string[] = [];
        const pr = child_process.spawn(cmd, args);
        pr.on('error', (err: Error) => {
            reject(err);
        });
        pr.on('close', () => {
            accept(out.join(''));
        });
        pr.stdout.on("data", (d) => {
            out.push(d.toString());
        });

    });
}

class Button extends WritablePropertyImpl<void> {
    constructor(name: string, private action: () => void ) { 
        super(name, void 0); 
    }

    set(val: void): void {
        this.action();
    }

    static create<T extends Controller>(name: string, action: () => void ): Button {
        return new Button(name, action);
    }
}

class GPIORelay extends Relay {
    private _init: Promise<void>;
    static readonly gpioCmd = "/root/WiringOP/gpio/gpio";

    constructor(readonly name: string, public readonly pin: number) { 
        super(name); 

        this._init = runShell(GPIORelay.gpioCmd, ["-1", "mode", "" + this.pin, "out"])
            .then(() => {
                return runShell(GPIORelay.gpioCmd, ["-1", "read", "" + this.pin])
                    .then((str) => {
                        this.setInternal(str.startsWith("0"));
                        return void 0;
                    })
                    .catch(err => console.log(err.errno));

            })
            .catch(err => console.log(err.errno));
    }

    switch(on: boolean): Promise<void> {
        // console.log("Here ", on);
        return this._init.then(() => {
            return runShell(GPIORelay.gpioCmd, ["-1", "write", "" + this.pin, on ? "0" : "1"])
                .then(() => this.setInternal(on))
                .catch(err => console.log(err.errno));
        });
    }
}

class MiLightBulb implements Controller {
    readonly name = "MiLight";
    readonly online = true;
    readonly properties: Property<any>[] = [
        new (class MiLightBulbRelay extends WritablePropertyImpl<boolean> {
            constructor(
                readonly pThis: MiLightBulb) {
                super("On/off", false);
            }

            set(on: boolean): Promise<void> {
                if (on) {
                    return this.pThis.send([0x42, 0x00, 0x55])
                        .then(() => delay(100).then(
                            () => this.pThis.send([0xC2, 0x00, 0x55])
                        ));
                } else {
                    return this.pThis.send([0x46, 0x00, 0x55]);
                }
            }
        })(this),
        new (class BrightnessProperty extends WritablePropertyImpl<number> {
            constructor(public readonly pThis: MiLightBulb) {
                super("Brightness", 50);
            }
            public set(val: number): void {
                this.pThis.send([0x4E, 0x2 + (0x15 * val / 100), 0x55])
                    .then(() => this.setInternal(val));
            }
        })(this),
        new (class BrightnessProperty extends WritablePropertyImpl<number> {
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

class Tablet implements Controller {
    private _name: string;
    private _androidVersion: string;
    public get name() { return this._online ? `${this._name}, android ${this._androidVersion}` : "Getting data"; }

    private _online: boolean = false;
    private _timer?: NodeJS.Timer;
    public get online() { return this._online; }

    constructor(public readonly id: string) {
        this._name = id;
        this._androidVersion = "<Unknown>";
    }

    private volume = new (class VolumeControl extends WritablePropertyImpl<number> {
        constructor(private readonly tbl: Tablet) {
            super("Volume", 0);
        }

        set(val: number): void {
            this.tbl.setVolume(val);
        }
    })(this);

    private screenIsOn = new (class TabletOnOffRelay extends Relay {
        constructor(private readonly tbl: Tablet) {
            super(tbl.id + " on/off");
        }
    
        public switch(on: boolean): Promise<void> {
            return this.tbl.screenIsSwitchedOn().then(onNow => {
                if (on !== onNow) {
                    return this.tbl.shellCmd("input keyevent KEYCODE_POWER").then(res => {
                        return delay(300).then(() => this.tbl.screenIsSwitchedOn().then(onNow => {
                            this.setInternal(onNow);
                            return Promise.resolve(void 0); // Already in this state
                        }));
                    })
                } else {
                    return Promise.resolve(void 0); // Already in this state
                }
            });
        }
    })(this);

    public properties: Property<any>[] = [
        this.volume,
        this.screenIsOn,
        Button.create("Reset", () => this.shellCmd("reboot")),
        Button.create("Stop playing", () => this.shellCmd("am force-stop org.videolan.vlc"))
    ]

    public serializable(): any{
        return {
            id: this.id, 
            name: this.name
        }
    }

    private shellCmd(cmd: string): Promise<string> {
        return new Promise<string>((accept, reject) => {
            adbClient.shell(this.id, cmd)
                .then(adbkit.util.readAll)
                .then((output: string) => {
                    accept(output);
                })
                .catch((err: Error) => reject(err));
            });
    };

    private settingVolume = Promise.resolve(void 0);

    public setVolume(vol: number): Promise<void> {
        return this.settingVolume.then(() => 
            this.settingVolume = this.getVolume().then(volNow => {
                var times = (volNow - vol)/15;
                var updown = "DOWN";
                if (times < 0) {
                    updown = "UP";
                    times = -times;
                }
                const shellCmd = ("input keyevent KEYCODE_VOLUME_" + updown + ";").repeat(times);
                console.log('setVolume', volNow, vol, shellCmd);
                if (!!shellCmd) {
                    return this.shellCmd(shellCmd)
                        .then(() => {
                            return this.settingVolume = Promise.resolve(void 0);
                        });
                } else {
                    return this.settingVolume = Promise.resolve(void 0);
                }
            }));
    }

    public getVolume(): Promise<number> {
        const t = Date.now();
        return new Promise<number>((accept_, reject) => {
            const accept = (val: number) => {
                console.log(Date.now() - t, "ms", val);
                accept_(val);
            }
            this.shellCmd('dumpsys audio')
                .then((output: string) => {
                    const str = output.toString();
                    const allTheLines = str.split('- STREAM_');
                    const musicLines = allTheLines.filter(ll => ll.startsWith('MUSIC:'))[0];
                    const musicLinesArray = musicLines.split(/\r\n|\r|\n/);
                    const muteCountLine = musicLinesArray.filter(ll => ll.startsWith("   Mute count:"))[0];
                    const mutedLine = musicLinesArray.filter(ll => ll.startsWith("   Muted:"))[0];

                    if (!!mutedLine && mutedLine !== '   Muted: false') {
                        accept(0);
                    } else if (!!muteCountLine && muteCountLine !== '   Mute count: 0') {
                        accept(0);
                    } else {
                        const currentLineStart = "   Current:";
                        const currVolLine = musicLinesArray.filter(ll => ll.startsWith(currentLineStart))[0];
                        const allValues = currVolLine.substring(currentLineStart.length+1).split(', ');
                        const currVol = allValues.filter(ll => ll.startsWith("2:"))[0];
                        if (!!currVol) {
                            const maxVol = allValues.filter(ll => ll.startsWith("1000:"))[0];                
                            const retVol = (+(currVol.split(': ')[1]) / +(maxVol.split(': ')[1]) * 100)
                            accept(retVol);
                        } else {
                            const currVol = allValues.filter(ll => ll.startsWith("2 (speaker):"))[0];
                            const retVol = (+(currVol.split(': ')[1]) / 15.) * 100.;
                            accept(retVol);
                        }
                
                    }
                })
                .catch(err => reject(err));
        });
    }

    public screenIsSwitchedOn(): Promise<boolean> {
        return new Promise<boolean>((accept, reject) => {
            this.shellCmd('dumpsys power')
                .then((output: string) => {
                    const str = output.toString();
                    const lines: string[] = str.split(/\r\n|\r|\n/);
                    const data: { [k: string]: string|undefined } = {
                        mHoldingWakeLockSuspendBlocker: undefined,
                        mWakefulness: undefined
                    };
                    for (const line of lines) {
                        const trimmed = line.trim();
                        Object.getOwnPropertyNames(data).forEach(prop => {
                            if (trimmed.startsWith(prop + "=")) {
                                data[prop] = trimmed.substring(prop.length + 1);
                            }
                        });
                    }
                    
                    // console.log(this.name + "->" + JSON.stringify(data));
                    accept(data.mWakefulness == "Awake");
                })
                .catch(err => reject(err));
        });
    }

    public init() {
        // And then open shell
        adbClient.getProperties(this.id).then((props: {[k: string]: string}) => {
            this._name = props['ro.product.model'];
            this._androidVersion = props['ro.build.version.release'];

            this._online = true;
        });

        this._timer = setInterval(() => {
            this.timerTask();
        }, 10000);

        this.timerTask();
    }

    public timerTask() {
        this.screenIsSwitchedOn().then(on => {
            this.screenIsOn.setInternal(on);
        });
        this.getVolume().then(vol => {
            this.volume.setInternal(vol);
        });    
    }

    public stop() {
        if (!!this._timer) {
            clearInterval(this._timer);
        }
        this._online = false;
    }
}

class ControllerRelay extends Relay {
    constructor(readonly name: string) {
        super(name);
    }

    private controller?: ClockController;
    private index?: number;

    init(controller: ClockController, index: number): any {
        this.controller = controller;
        this.index = index;
    }

    switch(on: boolean): Promise<void> {
        if (this.controller && this.controller.online) {
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

class ClockController implements Controller {
    private pingId = 0;
    private intervalId?: NodeJS.Timer;
    private lastResponse = Date.now();
    private ws?: WebSocket;
    public readonly properties: Property<any>[];

    constructor(public readonly ip: string, public readonly name: string, public readonly properties_: Property<any>[], public readonly handle: ChildControllerHandle) {
        this.attemptToConnect();

        this.properties = properties_.concat([ 
            Button.create("Restart", () => this.reboot()),
        ]);

        this.properties.forEach((p, index) => {
            if (p instanceof ControllerRelay) {
                p.init(this, index);
            }
        });
    }

    public get online() {
        return !!this.ws && this.wasRecentlyContacted();
    }

    public dropConnection() {
        if (!!this.ws) {
            if (this.ws.readyState == this.ws.OPEN) {
                this.ws.close();
            }
        }
        this.ws = undefined;
        this.handle.disconnected(this);
    }

    public reboot(): void {
        this.send({ type: "reboot" });
    }

    public send(json: {}): Promise<void> {
        const txt = JSON.stringify(json);
        console.log(this + " SEND: " + txt);
        if (this.ws) {
            this.ws.send(txt);
        }
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

class App implements ChildControllerHandle {
    public expressApi: express.Express;
    public server: http.Server;
    public readonly wss: WebSocket.Server;
    public currentTemp?: number;
    private config: IConfig;

    private r1 = new GPIORelay("Лампа на шкафу", 38);
    private r2 = new GPIORelay("Колонки", 40);
    private r3 = new GPIORelay("Коридор", 36);
    private r4 = new GPIORelay("Потолок", 32);

    private tempProperty = new (class Temp extends PropertyImpl<string> {
        constructor() {
            super("Температура", "Нет данных")
        }
    })();

    private ctrlGPIO = {
        name: "Комната",
        online: true, // Always online
        properties: [this.r1, this.r2, this.r3, this.r4]
    }

    private ctrlRoomClock = new ClockController("192.168.121.75", "Часы в комнате", [ this.tempProperty ], this);
    private ctrlKitchen = new ClockController("192.168.121.131", "Часы на кухне", [ 
        new ControllerRelay("Потолок"),
        new ControllerRelay("Лента")
    ], this);

/*
    private ctrlClock = {
        name: "Часы и датчик температуры",
        online: true,
        properties: [  ]
    }
*/
    private ctrlLamp = new MiLightBulb();

    private readonly kindle: Tablet = new Tablet('192.168.121.166:5556');
    private readonly nexus7: Tablet = new Tablet('00eaadb6');

    private readonly tablets: Map<string, Tablet> = new Map();

    private readonly controllers: Controller[] = [ 
        this.ctrlGPIO, 
        this.ctrlRoomClock,
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

        adbClient.trackDevices()
            .then((tracker: adbkit.Tracker) => {
                tracker.on('add', (dev: adbkit.Device) => {
                    // console.log("=== ADDED   = " + dev.id);
                    this.processDevice(dev);
                    // console.log(this.devices.map(d => d.id).join(", "));
                });
                tracker.on('remove', (dev: adbkit.Device) => {                    
                    const foundDev = this.tablets.get(dev.id);
                    if (foundDev) {
                        foundDev.stop();
                    }
                });
            });
        
        adbClient.listDevices()
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

        const wrap = (tag: string| [string, {[k: string]: string}], body?: string ) => {
            if (typeof tag == "string") {
                return `<${tag}>\n${body}\n</${tag}>`;
            } else {
                const props = Object.getOwnPropertyNames(tag[1]).map(pn => pn + "=\"" + tag[1][pn] + "\"");
                return `<${tag[0]} ${props.join(" ")}` + (!!body ? `>\n${body}\n</${tag[0]}>` : ">");
            }
        } 

        const hdr = [
            wrap(["meta", { 'http-equiv': "content-type", content:"text/html; charset=UTF-8" }]),
            wrap(["meta", { name: "viewport", content: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" }], undefined),
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
                        res = `<label><input type="checkbox" id=${id} 
                            ${avail ? "" : "disabled"} 
                            ${val ? "checked" : ""}
                            onclick="sendVal(${ctrlIndex}, ${prIndex}, document.getElementById('${id}').checked)"/>${prop.name}</label>`;
                    } else if (typeof val === "number") {
                        res = `<input ${avail ? "" : "disabled"}  type="range" id="${id}" min="0" max="100" value="${val}" 
                            oninput="sendVal(${ctrlIndex}, ${prIndex}, +document.getElementById('${id}').value)">${prop.name}</input>`;
                    } else if (typeof val === "string") {
                        res = `<label>${prop.name}<input ${avail ? "" : "disabled"}  type="text" id="${id}" value="${val}" 
                            oninput="sendVal(${ctrlIndex}, ${prIndex}, +document.getElementById('${id}').value)"/></label>`;
                    } else if (typeof val === "undefined") {
                        res = `<input ${avail ? "" : "disabled"}  type="button" id="${id}" value="${prop.name}" 
                            onclick="sendVal(${ctrlIndex}, ${prIndex}, document.getElementById('${id}').value)"></input>`;
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
                }).join("&nbsp;\n")
            }).join("<hr/>\n"))
        );
    }
    
    private processDevice(device: adbkit.Device): void {
        // Wait some time for device to auth...
        delay(1000).then(() => {
            const found = this.tablets.get(device.id);
            if (found) {
                found.init();
            }
        });
    }

    public listen(port: number, errCont: any) {
        this.server.listen(port, errCont);
    }

    public connected(controller: ClockController) {
        console.log(controller + " " + "Connected");
    }

    public disconnected(controller: ClockController) {
        console.log(controller + " " + "Disconnected");
    }

    public processMsg(controller: ClockController, data: Msg) {
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