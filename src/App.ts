import * as express from 'express'
import * as http from 'http';
import * as WebSocket from 'ws';
// import * as stream from "stream";
import * as fs from "fs";
import * as os from "os";
import * as dgram from "dgram";
import * as crypto from'crypto';

import * as util from "./Util";
import * as props from "./Props";

var adbkit = require('adbkit')
var adbClient = adbkit.createClient()

interface PingResult {
    type: 'pingresult';
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

interface Weight extends Msg {
    type: 'weight';
    value: number;
}

interface Button extends Msg {
    type: 'button';
    value: boolean;
}

interface Log extends Msg {
    type: 'log';
    val: string;
}

interface Ping extends Msg {
    type: 'ping';
    pingid: string;
}

interface RelayState extends Msg {
    type: 'relayState';
    id: number;
    value: boolean;
}

interface Hello extends Msg {
    type: 'hello';
    firmware: string;
    afterRestart: number;
    devParams: {
        "device.name": string,         // Device Name String("ESP_") + ESP.getChipId()
        "device.name.russian": string, // Device Name (russian)
        "wifi.name": string,           // WiFi SSID ""
        // "wifi.pwd": string,         // WiFi Password "true"
        "websocket.server": string,    // WebSocket server ""
        "websocket.port": string,      // WebSocket port ""
        "ntpTime": string,             // Get NTP time "true"
        "invertRelay": string,         // Invert relays "false"
        "hasScreen": string,           // Has screen "true"
        "hasHX711": string,            // Has HX711 (weight detector) "false"
        "hasDS18B20": string,          // Has DS18B20 (temp sensor) "false"
        "hasButton": string,           // Has button on D7 "false"
        "brightness": string           // Brightness [0..100] "0"
        "relay.names": string          // Relay names, separated by ;
    }
}

interface IRKey extends Msg {
    type: 'ir_key';
    remote: string;
    key: string;
}

type AnyMessage = Log | Temp | Hello | IRKey | Weight | Button | PingResult | RelayState;

interface JSONAble<T> {
    toJsonType(): T;
    fromJsonType(val: T): void;
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

abstract class Relay extends props.WritablePropertyImpl<boolean> {
    constructor(readonly name: string) {
        super(name, new props.CheckboxHTMLRenderer(), false);
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

class Button extends props.WritablePropertyImpl<void> {
    constructor(name: string, private action: () => void ) { 
        super(name, new props.ButtonRendrer(), void 0); 
    }

    set(val: void): void {
        this.action();
    }

    static create(name: string, action: () => void ): Button {
        return new Button(name, action);
    }
}

class GPIORelay extends Relay {
    private _init: Promise<void>;
    private _modeWasSet: boolean = false;
    static readonly gpioCmd = "/root/WiringOP/gpio/gpio";

    constructor(readonly name: string, public readonly pin: number) { 
        super(name); 

        this._init = util.runShell(GPIORelay.gpioCmd, ["-1", "read", "" + this.pin])
            .then((str) => {
                this.setInternal(str.startsWith("0"));
                return void 0;
            })
            .catch(err => console.log(err.errno))
    }

    switch(on: boolean): Promise<void> {
        // console.log("Here ", on);
        if (!this._modeWasSet) {
            this._init = this._init.then(() =>
                util.runShell(GPIORelay.gpioCmd, ["-1", "mode", "" + this.pin, "out"])
                    .then(() => Promise.resolve(void 0))
                    .catch(err => console.log(err.errno)));
        }
        
        return this._init.then(() => {
            return util.runShell(GPIORelay.gpioCmd, ["-1", "write", "" + this.pin, on ? "0" : "1"])
                .then(() => this.setInternal(on))
                .catch(err => console.log(err.errno));
        });
    }
}

class MiLightBulb implements props.Controller {
    readonly name = "MiLight";
    readonly online = true;
    readonly properties: props.Property<any>[] = [
        new (class MiLightBulbRelay extends props.WritablePropertyImpl<boolean> {
            constructor(
                readonly pThis: MiLightBulb) {
                super("On/off", new props.CheckboxHTMLRenderer(), false);
            }

            set(on: boolean): Promise<void> {
                if (on) {
                    return this.pThis.send([0x42, 0x00, 0x55])
                        .then(() => util.delay(100).then(
                            () => this.pThis.send([0xC2, 0x00, 0x55])
                        ));
                } else {
                    return this.pThis.send([0x46, 0x00, 0x55]);
                }
            }
        })(this),
        new (class BrightnessProperty extends props.WritablePropertyImpl<number> {
            constructor(public readonly pThis: MiLightBulb) {
                super("Brightness", new props.SliderHTMLRenderer(), 50);
            }
            public set(val: number): void {
                this.pThis.send([0x4E, 0x2 + (0x15 * val / 100), 0x55])
                    .then(() => this.setInternal(val));
            }
        })(this),
        new (class BrightnessProperty extends props.WritablePropertyImpl<number> {
            constructor(public readonly pThis: MiLightBulb) {
                super("Hue", new props.SliderHTMLRenderer(), 50);
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

class Tablet implements props.Controller {
    private _name: string;
    private _androidVersion: string;
    public get name() { return this._online ? `${this._name}, android ${this._androidVersion}` : "Offline"; }

    private _online: boolean = false;
    private _timer?: NodeJS.Timer;
    public get online() { return this._online; }

    constructor(public readonly id: string, private readonly tryToConnect: boolean) {
        this._name = id;
        this._androidVersion = "<Unknown>";

        const tbl = this;

        this.properties = [
            this.screenIsOn,
            this.volume,
            this.battery,
            this.playingUrl,
            new (class PlayLine extends props.WritablePropertyImpl<string> {
                set(val: string): void {
                    tbl.playURL(val);
                }
            })("Go play", new props.StringAndGoRendrer("Play"), ""),
            Button.create("Pause", () => this.shellCmd("am broadcast -a org.videolan.vlc.remote.Pause")),
            Button.create("Play", () => this.shellCmd("am broadcast -a org.videolan.vlc.remote.Play")),
            Button.create("Stop playing", () => this.shellCmd("am force-stop org.videolan.vlc")),
            Button.create("Reset", () => this.shellCmd("reboot")),
        ];
    }

    private volume = new (class VolumeControl extends props.WritablePropertyImpl<number> {
        constructor(private readonly tbl: Tablet) {
            super("Volume", new props.SliderHTMLRenderer(), 0);
        }

        set(val: number): void {
            this.tbl.setVolume(val);
        }
    })(this);

    private battery = new props.PropertyImpl<string>("Battery", new props.SpanHTMLRenderer(), "");

    private playingUrl = new props.PropertyImpl<string>("Now playing", new props.SpanHTMLRenderer(), "");

    public screenIsOn = new (class TabletOnOffRelay extends Relay {
        constructor(private readonly tbl: Tablet) {
            super("Screen on");
        }
    
        public switch(on: boolean): Promise<void> {
            return this.tbl.screenIsSwitchedOn().then(onNow => {
                if (on !== onNow) {
                    return this.tbl.shellCmd("input keyevent KEYCODE_POWER").then(res => {
                        return util.delay(300).then(() => this.tbl.screenIsSwitchedOn().then(onNow => {
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

    public readonly properties: props.Property<any>[];

    public serializable(): any{
        return {
            id: this.id, 
            name: this.name
        }
    }

    private _connectingNow = false;

    private connectIfNeeded(): Promise<void> {
        if (!this._online && this.tryToConnect && !this._connectingNow) {
            // We should try to connect first
            const parse = this.id.match(/([^:]*):?(\d*)/);
            if (parse) {
                this._connectingNow = true;
                return new Promise<void>((accept, reject) => {
                    adbClient.connect(parse[1], +(parse[2])).then(() => {
                        this._connectingNow = false;
                        this.init()
                            .then(() => accept())
                            .catch(() => reject());
                    })
                    .catch(() => {
                        this._connectingNow = false;
                    });
                });
            }
        }
        return Promise.resolve(void 0);
    }

    private shellCmd(cmd: string): Promise<string> {       
        return this.connectIfNeeded().then(
            () => new Promise<string>((accept, reject) => {
                adbClient.shell(this.id, cmd)
                    .then(adbkit.util.readAll)
                    .then((output: string) => {
                        accept(output.toString());
                    })
                    .catch((err: Error) => reject(err));
                }));
    };

    private settingVolume = Promise.resolve(void 0);

    public playURL(url: string): Promise<void> {
        return this.shellCmd(
            "am start -n org.videolan.vlc/org.videolan.vlc.gui.video.VideoPlayerActivity -a android.intent.action.VIEW -d \"" + 
                url.replace("&", "\&")+ "\" --ez force_fullscreen true")
            .then(() => {
                return Promise.resolve(void 0);
            })
    }

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
        return new Promise<number>((accept, reject) => {
            this.shellCmd('dumpsys audio | grep -E \'STREAM|Current|Mute\'')
                .then((str: string) => {
                    const allTheLines = str.split('- STREAM_');
                    const musicLines = allTheLines.filter(ll => ll.startsWith('MUSIC:'))[0];
                    const musicLinesArray = util.splitLines(musicLines);
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

    public getBatteryLevel(): Promise<number> {
        return this.shellCmd('dumpsys battery | grep level')
            .then((output: string) => {
                return +(output.split(':')[1]);
            });
    }

    public screenIsSwitchedOn(): Promise<boolean> {
        return new Promise<boolean>((accept, reject) => {
            const data: Map<string, string> = new Map([
                ["mHoldingWakeLockSuspendBlocker", ""],
                ["mWakefulness", ""]
            ]);

            this.shellCmd('dumpsys power | grep -E \'' + Array.from(data.keys()).join('|') + '\'')
                .then((output: string) => {
                    const str = output.toString();
                    const lines: string[] = str.split(/\r\n|\r|\n/);
                    for (const line of lines) {
                        const trimmed = line.trim();
                        
                        Array.from(data.keys()).forEach(prop => {
                            if (trimmed.startsWith(prop + "=")) {
                                data.set(prop, trimmed.substring(prop.length + 1));
                            }
                        });
                    }
                    
                    // console.log(this.name + "->" + JSON.stringify(data));
                    accept(data.get("mWakefulness") === "Awake");
                })
                .catch(err => reject(err));
        });
    }

    public init(): Promise<void> {
        // And then open shell
        return adbClient.getProperties(this.id).then((props: {[k: string]: string}) => {
            this._name = props['ro.product.model'];
            this._androidVersion = props['ro.build.version.release'];

            this._timer = setInterval(() => {
                this.timerTask();
            }, 10000);
    
            this.timerTask();    

            this._online = true;

            return void 0;
        });
    }

    public timerTask() {
        this.screenIsSwitchedOn().then(on => {
            this.screenIsOn.setInternal(on);
        });
        this.getVolume().then(vol => {
            this.volume.setInternal(vol);
        });
        this.getBatteryLevel().then(vol => {
            this.battery.setInternal(vol + "%");
        });
        this.playingUrlNow().then(url => {
            this.playingUrl.setInternal(url || "<nothing>");
        });
    }

    public playingUrlNow(): Promise<string|undefined> {
        return this.shellCmd("dumpsys activity activities | grep 'Intent {'").then(
            res => {
                const firstLine = util.splitLines(res)[0];
                // console.log("playingUrlNow", util.splitLines(res));
                const match = firstLine.match(/dat=(\S*)\s/);
                if (match) {
                    const url = match[1];
                    return url;
                }
                return undefined;
            }
        )
    }

    public stop() {
        if (!!this._timer) {
            clearInterval(this._timer);
        }
        this._online = false;
        // Try to connect
        this.connectIfNeeded();
    }
}

class ControllerRelay extends Relay {
    constructor(
        private readonly controller: ClockController, 
        private readonly index: number, 
        readonly name: string) {
        super(name);
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

interface LcdInformer {
    runningLine(str: string): void;
    staticLine(str: string): void;
    additionalInfo(str: string): void;
}

interface ClockControllerEvents {
    onDisconnect: () => void;
    onTemperatureChanged: (temp: number) => void;
    onWeightReset: () => void;
    onWeightChanged: (weight: number) => void;
}

class ClockController extends props.ClassWithId implements props.Controller {
    protected pingId = 0;
    protected intervalId?: NodeJS.Timer;
    protected lastResponse = Date.now();
    private readonly _name: string;
    public readonly properties: props.Property<any>[];
    public get name() { return this._name + " (" + this.ip + ")"; }
    public readonly lcdInformer?: LcdInformer;

    private tempProperty = new props.PropertyImpl<string>("Температура", new props.SpanHTMLRenderer(), "Нет данных");
    private weightProperty = new props.PropertyImpl<string>("Вес", new props.SpanHTMLRenderer(), "Нет данных");
    private baseWeight?: number;
    private lastWeight?: number;
    private relays: ControllerRelay[] = [];

    constructor(private readonly ws: WebSocket, 
        public readonly ip: string, 
        readonly hello: Hello,
        private readonly handler: ClockControllerEvents) {
        super();

        this._name = hello.devParams['device.name.russian'] || hello.devParams['device.name'];
        this.lastResponse = Date.now();

        this.properties = [];
        if (hello.devParams['hasHX711'] === 'true') {
            this.properties.push(this.weightProperty);
            this.properties.push(Button.create("Weight reset", () => this.tare()));
        }
        if (hello.devParams['hasDS18B20'] === 'true') {
            this.properties.push(this.tempProperty);
        }
        if (hello.devParams["hasScreen"]) {
            this.lcdInformer = {
                runningLine: (str) => {
                    this.send({ type: 'show', text: str });
                },
                staticLine: (str) => {
                    this.send({ type: 'tune', text: str });
                },
                additionalInfo: (str) => {
                    this.send({ type: 'additional-info', text: str });
                }
            };
        }
        if (!!hello.devParams['relay.names']) {
            hello.devParams['relay.names']
                .split(';')
                .forEach((rn, index) => {
                    const relay = new ControllerRelay(this, index, rn);
                    this.relays.push(relay);
                    this.properties.push(relay);
                });
        }

        this.properties.push(Button.create("Restart", () => this.reboot()));

        this.intervalId = setInterval(() => {
            // console.log(this.name, "wasRecentlyContacted", this.wasRecentlyContacted());
            if (!this.wasRecentlyContacted()) {
                // 6 seconds passed, no repsonse. Drop the connection and re-try
                this.dropConnection();
            } else {
                this.send({ type: 'ping', pingid: ("" + (this.pingId++)) } as Ping);
            }
        }, 2000);

        console.log('Connected ' + this.name);
    }

    public get online() {
        return !!this.ws && this.wasRecentlyContacted();
    }

    public dropConnection() {
        // console.log(this.ip, "dropConnection", this.ws.readyState, [this.ws.CONNECTING, this.ws.OPEN]);
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
            this.handler.onDisconnect();
        }
        if (this.ws.readyState === this.ws.OPEN) {
            // console.log(this.ip, "CLOSE");
            this.ws.close();
        }
    }

    public reboot(): void {
        this.send({ type: "reboot" });
    }

    public send(json: Object): Promise<void> {
        const txt = JSON.stringify(json);
        // console.log(this + " SEND: " + txt);
        try {
            this.ws.send(txt);
        } catch (err) {
            // Failed to send, got error, let's reconnect
            this.dropConnection();
        }
        return Promise.resolve(void 0);
    }

    public toString() : string { return this.name; }

    protected wasRecentlyContacted() {
        return Date.now() - this.lastResponse < 4000;
    }

    private tare(): void {
        this.handler.onWeightReset();
        util.delay(500).then(() => {
            this.baseWeight = this.lastWeight;
        });
    }

    private reportWeight(): void {
        if (this.lastWeight && this.baseWeight) {
            const gramms = Math.floor((this.lastWeight - this.baseWeight) / 410);
            this.weightProperty.setInternal(gramms + " г");
            this.handler.onWeightChanged(gramms);
        }
    }

    public processMsg(objData: AnyMessage) {
        this.lastResponse = Date.now();
        switch (objData.type) {
            case 'pingresult':
                break;
            case 'temp':
                this.tempProperty.setInternal(objData.value + "&#8451;");
                this.handler.onTemperatureChanged(objData.value);
                break;
            case 'log':
                console.log(this + " " + "log: ", objData.val);
                break;
            case 'button':
                this.tare();
                break;
            case 'weight':
                if (!this.baseWeight) {
                    this.baseWeight = objData.value;
                }
                this.lastWeight = objData.value;
                this.reportWeight();
                
                // console.log(this + " " + "weight: ", objData.value);
                break;
            case 'ir_key':
                console.log(this + " " + "irKey: ", objData.remote, objData.key);
                break;
            case 'relayState':
                // console.log(this + " " + "relayState: ", objData.id, objData.value);
                this.relays[objData.id].setInternal(objData.value);
                break;
            default:
                console.log(this + " UNKNOWN CMD: ", objData);
        }
    }
} 


class App {
    public expressApi: express.Express;
    public server: http.Server;
    public readonly wss: WebSocket.Server;
    public currentTemp?: number;

    private r1 = new GPIORelay("Лампа на шкафу", 38);
    private r2 = new GPIORelay("Колонки", 40);
    private r3 = new GPIORelay("Коридор", 36);
    private r4 = new GPIORelay("Потолок", 32);

    private ctrlGPIO = {
        name: "Комната",
        online: true, // Always online
        properties: [this.r1, this.r2, this.r3, this.r4]
    }

    private dynamicControllers: Map<string, ClockController> = new Map();
    private dynamicInformers: Map<string, LcdInformer> = new Map();
    // Show the message on all informers
    private allInformers: LcdInformer = {
        runningLine: (str) => {
            for (const inf of this.dynamicInformers.values()) {
                inf.runningLine(str);
            }
        },
        staticLine: (str) => {
            for (const inf of this.dynamicInformers.values()) {
                inf.staticLine(str);
            }
        },
        additionalInfo: (str) => {
            for (const inf of this.dynamicInformers.values()) {
                inf.additionalInfo(str);
            }
        }
    };

    private serverHashIdPromise: Promise<string> = new Promise((accept, reject) => {
        const hasho = crypto.createHash('md5');
        fs.readdir(__dirname, (err, files) => {
            if (err) {
                reject(err);
            }
            files.forEach(file => {
                const stat = fs.statSync(__dirname + "/" + file);
                hasho.update("" + stat.size);
                hasho.update("" + stat.mtime.getTime());
            });
            accept(hasho.digest("hex"));
          })
    });

    private ctrlLamp = new MiLightBulb();

    private readonly kindle: Tablet = new Tablet('192.168.121.166:5556', true);
    private readonly nexus7: Tablet = new Tablet('00eaadb6', false);

    private readonly tablets: Map<string, Tablet> = new Map();

    private timeProp(name: string, upto: number, onChange: (v:number|null)=>void) : props.WritablePropertyImpl<number|null> {
        return props.newWritableProperty<number>(
            name, 
            0, 
            new props.SelectHTMLRenderer<number|null>(Array.from({length: upto + 1}, ((v, k) => k == 0 ? null : k-1)), i => i === null ? " - " : "" + i), 
            (v:number|null) => { onChange(v); });
    }


    private createTimer(name: string, onFired: ((d: Date) => void)) : 
        { val: Date|null, controller: props.Controller } & JSONAble<string> {
        const onDateChanged = () => {
            const hh = hourProp.get();
            const mm = minProp.get();

            if (hh !== null && mm !== null) { 
                const d = new Date();
                d.setHours(hh);
                d.setMinutes(mm);
                const ss = secProp.get();
                d.setSeconds(ss !== null ? ss : 0);    
                if (d.getTime() < new Date().getTime()) {
                    // Add a day to point to tomorrow
                    d.setDate(d.getDate() + 1);
                }    
                setNewValue(d);
            } else {
                setNewValue(null);
            }
        };
        const hourProp = this.timeProp("Час", 24, onDateChanged);
        const minProp = this.timeProp("Мин", 60, onDateChanged);
        const secProp = this.timeProp("Сек", 60, onDateChanged);

        const min = 60;
        const hour = 60*min;
        const timerIn = [0, 10, 30, min, 2*min, 3*min, 5*min, 10*min, 15*min, 20*min, 30*min, 45*min, hour, 2*hour, 3*hour, 4*hour, 5*hour, 8*hour, 12*hour, 23*hour];

        const orBeforeProp = props.newWritableProperty<number>(
            "или через", 
            timerIn[0], 
            new props.SelectHTMLRenderer(timerIn, n => n ? util.toHourMinSec(n) : "никогда"), 
            (v:number) => {
                if (v != 0) {
                    const d = new Date();
                    d.setTime(d.getTime() + v*1000);
                    setNewValue(d);
                } else {
                    setNewValue(null);
                }
            });
        const beforeProp = props.newWritableProperty("через", "", new props.SpanHTMLRenderer(), () => {})
        var timer: NodeJS.Timer;

        const setNewValue = (d: Date|null) => {
            if (d !== that.val) {
                // that.val === undefined || that.val.getTime() != d.getTime())) {
                if (!!timer) {
                    clearTimeout(timer);
                }

                that.val = d;
                if (that.val !== null) {
                    const msBefore = (that.val.getTime() - new Date().getTime());
                    var secBefore = msBefore / 1000;
                    beforeProp.set(util.toHourMinSec(secBefore));
    
                    hourProp.setInternal(that.val.getHours());
                    minProp.setInternal(that.val.getMinutes());
                    secProp.setInternal(that.val.getSeconds());

                    const tt = that.val;
                    // Let's setup timer
                    timer = setTimeout(() => {
                        onFired(tt);
                    }, msBefore);
                } else {
                    beforeProp.set("никогда");
                    hourProp.set(null);
                    minProp.set(null);
                    secProp.set(null);
                }

                this.saveConf();
            }
        }

        const that = {
            val: null as Date|null,
            controller: {
                name: name,
                online: true, // Always online
                properties: [ 
                    hourProp, minProp, secProp, orBeforeProp, beforeProp
                ]
            },
            toJsonType: () => {
                return that.val !== null ? that.val.toJSON() : "null";
            },
            fromJsonType: (obj: string) => {
                setNewValue(new Date(obj));
            }
         };
         return that;
    }

    private initController(ct: props.Controller): void {
        ct.properties.forEach(prop => {
            prop.onChange(() => {
                this.broadcastToWebClients({
                    type: "onPropChanged",
                    id: prop.id,
                    name: prop.name,
                    val: prop.get()
                });
            });    
        })
    }

    public sleepAt = this.createTimer("Выкл", d => { 
        // console.log("!!! SLEEEP !!!");
        // console.log(d); 
        //this.kindle.screenIsOn.set(false);
        this.nexus7.screenIsOn.set(false);
    });
    public wakeAt = this.createTimer("Вкл", d => { 
        console.log(d); 
        this.nexus7.screenIsOn.set(true);
    });

    private ctrlControlOther = {
        name: "Другое",
        online: true, // Always online
        properties: [
            Button.create("Reboot server", () => util.runShell("reboot", [])),
            props.newWritableProperty("Switch devices to server", "192.168.121.38", new props.StringAndGoRendrer("Go"), (val: string) => {
                for (const ctrl of this.dynamicControllers.values()) {
                    ctrl.send({ type: 'setProp', prop: 'websocket.server', value: val });
                    ctrl.send({ type: 'setProp', prop: 'websocket.port', value: '3000' });
                    util.delay(1000).then(() => ctrl.reboot());
                }
                console.log('Switch all devices to other server');    
            })
        ]
    }

    private get controllers(): props.Controller[] {
        const dynPropsArray = Array.from(this.dynamicControllers.values());
        dynPropsArray.sort((a, b) => a.id == b.id ? 0 : (a.id < b.id ? -1 : 1));

        return Array.prototype.concat([ 
            this.sleepAt.controller,
            this.wakeAt.controller,
            this.ctrlControlOther,
            this.ctrlGPIO, 
            this.ctrlLamp, 
            this.kindle, 
            this.nexus7 
        ], dynPropsArray);
    }

    public static confFileName() {
        return os.homedir() + '/nodeserver.stored.conf.json';
    }
    private saveConf() {
        const toSerialize = Object.keys(this)
            .filter(prop => typeof((this as any)[prop]) == "object" && "toJsonType" in (this as any)[prop]);
        
        const resJson: any = {};
        toSerialize.forEach(prop => {
            resJson[prop] = (this as any)[prop].toJsonType();
        });
        fs.writeFileSync(App.confFileName(), JSON.stringify(resJson));
    }

    constructor() {
        this.expressApi = express();

        this.tablets.set(this.kindle.id, this.kindle);
        this.tablets.set(this.nexus7.id, this.nexus7);

        if (fs.existsSync(App.confFileName())) {
            const data = fs.readFileSync(App.confFileName());
            const parsed = JSON.parse(data.toString());

            Object.getOwnPropertyNames(parsed).forEach(prop => {
                (this as any)[prop].fromJsonType(parsed[prop]);
            })
        }

        this.server = http.createServer(this.expressApi);

        this.wss = new WebSocket.Server({ server: this.server });
        this.wss.on('connection', (ws: WebSocket, request) => {
            const url = request.url;
            // console.log("Connection from", request.connection.remoteAddress, request.url);
            const esp: boolean = url === '/esp';
            const remoteAddress = request.connection.remoteAddress;
            const ip = util.parseOr(remoteAddress, /::ffff:(.*)/, remoteAddress);
            //connection is up, let's add a simple simple event
            if (esp) {
                // This is ESP controller!
                ws.on('message', (data: string) => {
                    const objData = JSON.parse(data);
                    const controller = this.dynamicControllers.get(ip);

                    // It might be hello message
                    if ('type' in objData && objData.type == 'hello') {
                        const hello = objData as Hello;

                        const clockController = new ClockController(ws, ip, hello, {
                            onDisconnect: () => {
                                this.dynamicControllers.delete(ip);
                                if (clockController.lcdInformer) {
                                    this.dynamicInformers.delete(ip);
                                }
                                this.broadcastToWebClients({ type: "reloadProps" });
                                this.allInformers.runningLine('Отключено ' + clockController.name);
                            },
                            onTemperatureChanged: (temp: number) => {
                                this.allInformers.additionalInfo((temp == 0 ? "" : (temp > 0 ? "+" : "-")) + temp + "\xB0");
                            },
                            onWeightChanged: (weight: number) => {
                                this.allInformers.staticLine(weight + "г");
                            },
                            onWeightReset: () => {
                                this.allInformers.staticLine("Сброс");
                            }
                        } as ClockControllerEvents);
                        if (!!controller) {
                            // What is happening here:
                            // hello comes again from the same controller
                            // it means it was reset - let's re-init it
                            controller.dropConnection();
                        }
                        this.dynamicControllers.set(ip, clockController);
                        if (clockController.lcdInformer) {
                            this.dynamicInformers.set(ip, clockController.lcdInformer);
                        }
                        this.initController(clockController);

                        this.allInformers.runningLine('Подключено ' + clockController.name);

                        // Reload
                        this.broadcastToWebClients({ type: "reloadProps" });

                        ws.on('error', () => { clockController.dropConnection(); });
                        ws.on('close', () => { clockController.dropConnection(); });                        
                    } else if (controller) {
                        controller.processMsg(objData);
                    } else {
                        console.error('Shall never be here', data);
                    }
                });
            } else if (url === '/web') {
                // This is web client. Let's report server revision
                this.serverHashIdPromise.then((hashId) => {
                    ws.send(JSON.stringify({type: 'serverVersion', val: hashId}));
                });

                ws.on('message', (message: string) => {
                    const msg = JSON.parse(message);
                    if (msg.type === "setProp") {
                        const prop = props.ClassWithId.byId<props.Property<any>>(msg.id);
                        if (prop) {
                            if (props.isWriteableProperty(prop)) {
                                prop.set(msg.val);
                            } else {
                                console.error(`Property ${prop.name} is not writable`);
                            }
                        } else {
                            console.error(`Property with id = ${msg.id} is not found`);
                        }
                    } else {
                        //log the received message and send it back to the client
                        console.log('received: %s', message);
                    }
                });

                ws.on('close', (message: string) => {
                    // console.log('closed web client');
                });
            } else {
                console.log("WTH???");
            }

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
                Array.from(this.tablets.values())
                    .filter(t => !devices.some(dev => dev.id === t.id))
                    .forEach(t => t.stop());
                devices.forEach(dev => {
                    this.processDevice(dev);
                });
            })
            .catch((err: Error) => {
                console.error('Something went wrong:', err.stack)
            })

        // Subscribe to all the props changes
        this.controllers.forEach(ct => {
            this.initController(ct);
        })
    }
    
    private renderToHTML(): string {
        const propChangedMap = this.controllers.map((ctrl, ctrlIndex) => {
            return ctrl.properties.map((prop: props.Property<any>, prIndex: number): string => {
                return `'${prop.id}' : (val) => { ${prop.htmlRenderer.updateCode(prop)} }`
            }).join(',\n');
        }).join(',\n');

        const hdr = [
            util.wrapToHTML(["meta", { 'http-equiv': "content-type", content:"text/html; charset=UTF-8" }]),
            util.wrapToHTML(["meta", { name: "viewport", content: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" }], undefined),
            util.wrapToHTML(["script", {type: "text/javascript"}], 
            `
            var reconnectInterval;
            var sock;
            var serverVersion;
            function start() {
                sock = new WebSocket("ws:/" + location.host + "/web");
                sock.onopen = () => {
                    console.log("Connected to websocket " + (new Date()));
                    clearInterval(reconnectInterval);
                    reconnectInterval = undefined;

                    sock.onmessage = function(event) {
                        // console.log(event.data);
                        const d = JSON.parse(event.data);
                        if (d.type === 'onPropChanged') {
                            propChangeMap[d.id](d.val);
                        } else if (d.type === 'reloadProps') {
                            location.reload(); // Temp, will be impl in other way
                        } else if (d.type === 'serverVersion') {
                            if (!!serverVersion && d.val !== serverVersion) {
                                // Server was updated, go reload!
                                location.reload();
                            }
                            serverVersion = d.val;
                        }
                    };
                };

                function reconnect() {
                    if (!reconnectInterval) {
                        reconnectInterval = setInterval(() => {
                            start();
                        }, 2000);
                    }
                }
                sock.onerror = reconnect;
                sock.onclose = reconnect;
            }
            start();

            const propChangeMap = {
                ${propChangedMap}
            };

            function sendVal(id, name, val) {
                sock.send(JSON.stringify({ 
                    type: 'setProp',
                    id: id,
                    name: name,
                    val: val }));
            };
            `)
        ];
        return util.wrapToHTML(["html", { lang: "en"}], 
            util.wrapToHTML("head", hdr.join("\n")) + "\n" +
            util.wrapToHTML("body", this.controllers.map((ctrl) => {
                return ctrl.name + "<br/>" + ctrl.properties.map((prop: props.Property<any>): string => {
                    let res = "";

                    res = prop.htmlRenderer.body(prop);

                    return res;
                }).join("&nbsp;\n")
            }).join("<hr/>\n"))
        );
    }
    
    private processDevice(device: adbkit.Device): void {
        // Wait some time for device to auth...
        util.delay(1000).then(() => {
            const found = this.tablets.get(device.id);
            if (found) {
                found.init();
            }
        });
    }

    public listen(port: number, errCont: any) {
        this.server.listen(port, errCont);
    }

    private broadcastToWebClients(arg: Object): void {
        this.wss.clients.forEach(cl => {
            try {
                cl.send(JSON.stringify(arg));
            } catch (e) {
                // Ignore it
            }
        });
    }

}

process.on('uncaughtException', (err: Error) => {
    console.error(err.stack);
    console.log("Node NOT Exiting...");
});

export default new App()