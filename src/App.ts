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

interface JSONAble<T extends string|number|boolean> {
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

class GPIORelay extends Relay implements JSONAble<boolean> {
    private _init: Promise<void>;
    private _modeWasSet: boolean = false;
    static readonly gpioCmd = "/root/WiringOP/gpio/gpio";

    constructor(readonly name: string, public readonly pin: number, public readonly onChanged: () => void) { 
        super(name); 

        if (GPIORelay.gpioInstalled()) {
            this._init = util.runShell(GPIORelay.gpioCmd, ["-1", "read", "" + this.pin])
                .then((str) => {
                    this.setInternal(str.startsWith("0"));
                    return void 0;
                })
                .catch(err => console.log(err.errno))
        } else {
            this._init = Promise.resolve(void 0);
        }
    }

    static gpioInstalled(): boolean {
        return fs.existsSync(GPIORelay.gpioCmd);
    }

    switch(on: boolean): Promise<void> {
        // console.trace("GPIO switch ", on);
        if (!this._modeWasSet) {
            this._init = this._init.then(() =>
                util.runShell(GPIORelay.gpioCmd, ["-1", "mode", "" + this.pin, "out"])
                    .then(() => Promise.resolve(void 0))
                    .catch(err => console.log(err.errno)));
        }
        
        return this._init.then(() => {
            return util.runShell(GPIORelay.gpioCmd, ["-1", "write", "" + this.pin, on ? "0" : "1"])
                .then(() => { this.setInternal(on); this.onChanged(); })
                .catch(err => console.log(err.errno));
        });
    }

    public toJsonType() { 
        return this.get(); 
    }
    public fromJsonType(val: boolean): void {
        this.set(val);
    }
}

class MiLightBulb implements props.Controller {
    readonly name = "MiLight";
    readonly online = true;
    readonly ip = "192.168.121.35";
    readonly port = 8899;

    public readonly switchOn = new (class MiLightBulbRelay extends Relay {
        constructor(
            readonly pThis: MiLightBulb) {
            super("On/off");
        }

        public switch(on: boolean): Promise<void> {
            return this.pThis.send([on ? 0x42 : 0x46, 0x00, 0x55])
                .then(() => this.setInternal(on));
        }
    })(this);

    public readonly allWhite = props.newWritableProperty<boolean>("All white", false, new props.CheckboxHTMLRenderer(), 
        (val: boolean) => {
            if (val) {
                this.send([0xC2, 0x00, 0x55]);
            } else {
                this.send([0x40, (0xff * this.hue.get() / 100), 0x55]);
            }
        });
    
    public readonly brightness = props.newWritableProperty<number>("Brightness", 50, new props.SliderHTMLRenderer(), 
        (val: number) => {
            this.send([0x4E, 0x2 + (0x15 * val / 100), 0x55]);
        });

    public readonly hue = props.newWritableProperty<number>("Hue", 50, new props.SliderHTMLRenderer(), 
        (val: number) => {
            this.allWhite.set(false);
        });

    readonly properties: props.Property<any>[] = [
        this.switchOn,
        this.allWhite,
        this.brightness,
        this.hue
    ];

    private send(buf: number[]): Promise<void> {
        const sock = dgram.createSocket("udp4");
        return new Promise<void>((accept, reject) => {
            sock.send(
                Buffer.from(buf), this.port, this.ip,
                (err, bytes) => {
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
            Button.create("Stop playing", () => this.stopPlaying()),
            Button.create("Reset", () => this.shellCmd("reboot")),
        ];
    }

    public volume = new (class VolumeControl extends props.WritablePropertyImpl<number> {
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

    public stopPlaying(): Promise<void> {
        return this.shellCmd("am force-stop org.videolan.vlc").then(() => void 0);
    }

    public playURL(url: string): Promise<void> {
        return this.stopPlaying().then(() => this.shellCmd(
            "am start -n org.videolan.vlc/org.videolan.vlc.gui.video.VideoPlayerActivity -a android.intent.action.VIEW -d \"" + 
                url.replace("&", "\&")+ "\" --ez force_fullscreen true")
            .then(() => {
                return Promise.resolve(void 0);
            }));
    }

    public changeVolume(up: boolean): Promise<void> {
        return this.getVolume().then((volNow: number) => {
            if ((volNow < 5 && !up) || (volNow > 95 && up)) {
                return Promise.resolve(void 0);
            }

            return this.shellCmd("input keyevent KEYCODE_VOLUME_" + (up ? "UP" : "DOWN")).then(() => void 0)
        });
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
                    if (musicLines.length < 0) {
                        reject(new Error("Empty resopnce of dumpsys audio"));
                        return;
                    }
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
        this.getVolume()
            .then(vol => {
                this.volume.setInternal(vol);
            })
            .catch(e => console.log(e));
        this.getBatteryLevel()
            .then(vol => {
                this.battery.setInternal(vol + "%");
            })
            .catch(e => console.log(e));
        this.playingUrlNow()
            .then(url => {
                this.playingUrl.setInternal(url || "<nothing>");
            })
            .catch(e => console.log(e));
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
    onIRKey: (remoteId: string, keyId: string) => void;
}

type TimerProp = { val: Date|null, controller: props.Controller, fireInSeconds: (sec: number) => void } & JSONAble<string>;

class ClockController extends props.ClassWithId implements props.Controller {
    protected pingId = 0;
    protected intervalId?: NodeJS.Timer;
    protected lastResponse = Date.now();
    private readonly _name: string;
    public readonly properties: props.Property<any>[];
    public get name() { return this._name + " (" + this.ip + ")"; }
    public readonly lcdInformer?: LcdInformer;
    public readonly internalName: string;

    private tempProperty = new props.PropertyImpl<string>("Температура", new props.SpanHTMLRenderer(), "Нет данных");
    private weightProperty = new props.PropertyImpl<string>("Вес", new props.SpanHTMLRenderer(), "Нет данных");
    private baseWeight?: number;
    private lastWeight?: number;
    public readonly relays: ControllerRelay[] = [];

    constructor(private readonly ws: WebSocket, 
        public readonly ip: string, 
        readonly hello: Hello,
        private readonly handler: ClockControllerEvents) {
        super();

        this.internalName = hello.devParams['device.name'];

        this._name = hello.devParams['device.name.russian'] || this.internalName;
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
                this.handler.onIRKey(objData.remote, objData.key);
                // console.log(this + " " + "irKey: ", );
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

interface IRKeysHandler {
    remote?: string;
    /**
     * This method should check array and return milliseconds before accepting
     */
    partial(arr: string[]): number|null;
    /**
     * Accept the command
     */
    complete(arr: string[]): void;
}

class App {
    public expressApi: express.Express;
    public server: http.Server;
    public readonly wss: WebSocket.Server;
    public currentTemp?: number;

    private r1 = new GPIORelay("Лампа на шкафу", 38, () => this.saveConf());
    private r2 = new GPIORelay("Колонки", 40, () => this.saveConf());
    private r3 = new GPIORelay("Коридор", 36, () => this.saveConf()); 
    private r4 = new GPIORelay("Потолок", 32, () => this.saveConf());

    private ctrlGPIO = {
        name: "Комната",
        online: GPIORelay.gpioInstalled(), // 
        properties: [this.r1, this.r2, this.r3, this.r4]
    }

    private dynamicControllers: Map<string, ClockController> = new Map();

    findDynController(internalName: string): ClockController|undefined {
        for (const ctrl of this.dynamicControllers.values()) {
            if (ctrl.internalName == internalName) {
                return ctrl;
            }
        }
        return undefined;
    }


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

    private readonly miLight = new MiLightBulb();

    private readonly kindle: Tablet = new Tablet('192.168.121.166:5556', true);
    private readonly nexus7: Tablet = new Tablet('00eaadb6', false);

    private readonly tablets: Map<string, Tablet> = new Map();

    private timeProp(name: string, upto: number, onChange: (v:number)=>void) : props.WritablePropertyImpl<number> {
        return props.newWritableProperty<number>(
            name, 
            0, 
            new props.SelectHTMLRenderer<number>(Array.from({length: upto}, ((v, k) => k)), i => "" + i), 
            (v:number) => { onChange(v); });
    }

    private createTimer(name: string, onFired: ((d: Date) => void)) : TimerProp {
        const onDateChanged = () => {
            const hh = hourProp.get();
            const mm = minProp.get();
            const ss = secProp.get();

            if (hh !== null && mm !== null) { 
                setNewValue(util.thisOrNextDayFromHMS(hh, mm, ss || 0));
                orBeforeProp.setInternal(1);
            } else {
                setNewValue(null);
            }
        };
        const hourProp = this.timeProp("Час", 24, onDateChanged);
        const minProp = this.timeProp("Мин", 60, onDateChanged);
        const secProp = this.timeProp("Сек", 60, onDateChanged);

        const min = 60;
        const hour = 60*min;
        const timerIn: string[] = 
            ["never", "atdate"].concat(
                [1, 5, 10, 15, 20, 30, 45, min, 2*min, 3*min, 5*min, 10*min, 15*min, 20*min, 30*min, 45*min, 
                    hour, 2*hour, 3*hour, 4*hour, 5*hour, 8*hour, 12*hour, 23*hour].map(n => "val" + n));

        const orBeforeProp: props.WritablePropertyImpl<number> = props.newWritableProperty<number>(
            "через", 
            0, 
            new props.SelectHTMLRenderer<number>(Array.from({length: timerIn.length}, (e, i) => i), _n => {
                // console.log(_n);
                const n = timerIn[_n];
                if (n.startsWith("val")) {
                    return util.toHourMinSec(+n.slice(3));
                } else if (n === "never") {
                    return "никогда"; 
                } else if (n === "atdate") {
                    return "в момент";
                }
                return "";
            }),
            (_n:number) => {
                const n = timerIn[_n];
                if (n.startsWith("val")) {
                    that.fireInSeconds(+n.slice(3));
                } else if (n === "never") {
                    setNewValue(null);
                } else if (n === "atdate") {
                    onDateChanged();
                }
            });
        var timer: NodeJS.Timer;

        const setNewValue = (d: Date|null) => {
            console.log(name + " --> " + d);
            if (d !== that.val) {
                // that.val === undefined || that.val.getTime() != d.getTime())) {
                if (!!timer) {
                    clearTimeout(timer);
                }

                that.val = d;
                if (that.val !== null) {
                    const msBefore = (that.val.getTime() - new Date().getTime());

                    hourProp.setInternal(that.val.getHours());
                    minProp.setInternal(that.val.getMinutes());
                    secProp.setInternal(that.val.getSeconds());
                    orBeforeProp.setInternal(1);

                    const tt = that.val;
                    // Let's setup timer
                    timer = setTimeout(() => {
                        onFired(tt);
                        setNewValue(null);
                    }, msBefore);
                } else {
                    // Dropped timer
                    // hourProp.setInternal(0);
                    // minProp.setInternal(null);
                    // secProp.setInternal(null);
                    hourProp.setInternal(0);
                    minProp.setInternal(0);
                    secProp.setInternal(0);
                    orBeforeProp.setInternal(0);
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
                    hourProp, minProp, secProp, orBeforeProp
                ]
            },
            toJsonType: () => {
                return that.val !== null ? that.val.toJSON() : "null";
            },
            fromJsonType: (obj: string) => {
                if (obj == "null") {
                    setNewValue(null);
                } else {
                    setNewValue(new Date(obj));
                }
            },
            fireInSeconds: (sec: number) => {
                const d = new Date();
                d.setTime(d.getTime() + sec * 1000);
                setNewValue(d);
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

    public relaysState = {
        wasOnIds: [] as string[],
        toJsonType: function () {
            return JSON.stringify(this.wasOnIds);
        },
        fromJsonType(val: string): void {
            this.wasOnIds = JSON.parse(val);
        }
    }

    public sleepAt = this.createTimer("Выкл", d => { 
        console.log("SLEEP", d);
        //this.kindle.screenIsOn.set(false);
        const wasOnIds = [];
        for (const ctrl of this.controllers) {
            if (ctrl.online) {
                for (const prop of ctrl.properties) {
                    if (prop instanceof Relay) {
                        if (prop.get()) {
                            wasOnIds.push(prop.id);
                        }
                        prop.set(false);
                    }
                }
            }
        }
        this.relaysState.wasOnIds = wasOnIds;
    });

    public timer = this.createTimer("Таймер", d => { 
        console.log("Timer!");
        const ml = this.miLight;
        const oldOn = ml.switchOn.get();
        const oldAllWhite = ml.allWhite.get();
        const oldBright = ml.brightness.get();
        const oldHue = ml.hue.get();

        this.allInformers.staticLine("Время!");

        async function blinkMiLight() {
            await util.delay(300);
            await ml.switchOn.switch(true);
            await util.delay(200);
            ml.brightness.set(100);
            await util.delay(200);
            ml.hue.set(69); // reasonable red
            await util.delay(200);
            for (var i = 0; i < 5; ++i) {
                ml.brightness.set(100);
                await util.delay(500);
                ml.brightness.set(20);
                await util.delay(500);    
            }
            await util.delay(200);
            if (oldAllWhite) {
                ml.allWhite.set(oldAllWhite);
            } else {
                ml.hue.set(oldHue);                
            }
            await util.delay(200);
            ml.brightness.set(oldBright);
            await util.delay(200);
            ml.switchOn.set(oldOn);
        }

        const kr = this.findDynController('KitchenRelay');
        if (kr) {
            const stripeRelay = kr.relays[1];
            async function blinkKitchenStripe() {
                const wasOn = stripeRelay.get();
                for (var i = 0; i < 3; ++i) { 
                    stripeRelay.set(false);
                    await util.delay(600);
                    stripeRelay.set(true);
                    await util.delay(600);
                }
                stripeRelay.set(wasOn);
            }
            blinkKitchenStripe();
        }

        blinkMiLight();
    });

    public wakeAt = this.createTimer("Вкл", d => { 
        console.log("WAKE", d); 
        //this.nexus7.screenIsOn.set(true);
        for (const wo of this.relaysState.wasOnIds) {
            (props.ClassWithId.byId(wo) as Relay).set(true);
        }
        // this.miLight.brightness.set(50);
    });

    private ctrlControlOther = {
        name: "Другое",
        online: true, // Always online
        properties: [
            Button.create("Reboot server", () => util.runShell("reboot", [])),
            props.newWritableProperty("Switch devices to server", "192.168.121.38", new props.StringAndGoRendrer("Go"), (val: string) => {
                for (const ctrl of this.dynamicControllers.values()) {
                    ctrl.send({ type: 'setProp', prop: 'websocket.server', value: val });
                    ctrl.send({ type: 'setProp', prop: 'websocket.port', value: '8080' });
                    util.delay(1000).then(() => ctrl.reboot());
                }
                console.log('Switch all devices to other server');    
            })
        ]
    }

    private get onlineControllers(): props.Controller[] {
        return this.controllers.filter(c => c.online);
    }

    private channelsHistory = this.makeChannelsHistory();
    
    private makeChannelsHistory() {
        const that = this;
        var history = 
        [
            {
                "name": "24 \u0422\u0435\u0445\u043d\u043e",
                "cat": "history",
                "url": "http://172.31.254.110:5000/c12",
                "channel": 12
            },
            {
                "name": "Discovery Science HD",
                "cat": "history",
                "url": "http://live02-cdn.tv.ti.ru/dtv/id248_NBN_SG--DiscoveryScienceHD/04/plst.m3u8",
                "channel": 14
            },
            {
                "name": "\u0416\u0438\u0432\u0430\u044f \u043f\u043b\u0430\u043d\u0435\u0442\u0430",
                "cat": "history",
                "url": "http://172.31.254.110:5000/c37",
                "channel": 16
            },
            {
                "name": "History",
                "cat": "history",
                "url": "http://213.59.128.162:9999/play/History",
                "channel": 17
            },
            {
                "name": "National Geographic",
                "cat": "history",
                "url": "http://37.208.104.194:8090/ch-256/index.m3u8",
                "channel": 18
            },
            {
                "name": "\u0417\u0432\u0435\u0437\u0434\u0430",
                "cat": "history",
                "url": "https://strm.yandex.ru/kal/zvezda/zvezda0.m3u8",
                "channel": 19
            },
            {
                "name": "\u041a\u0412\u041d",
                "cat": "history",
                "url": "http://109.248.236.41:4433/udp/238.1.1.111:1234",
                "channel": 20
            },
            {
                "name": "Galaxy",
                "cat": "history",
                "url": "http://hlstv.kem.211.ru/239.211.211.39/stream.m3u8",
                "channel": 21
            },
            {
                "name": "\u041c\u043e\u044f \u041f\u043b\u0430\u043d\u0435\u0442\u0430",
                "cat": "history",
                "url": "http://172.31.254.110:5000/c7",
                "channel": 22
            },
            {
                "name": "\u041f\u043b\u0430\u043d\u0435\u0442\u0430 HD",
                "cat": "history",
                "url": "http://hlstv.kem.211.ru/239.211.200.19/stream.m3u8",
                "channel": 25
            },
            {
                "name": "Nat Geo Wild",
                "cat": "history",
                "url": "http://37.208.104.194:8090/ch-253/index.m3u8",
                "channel": 26
            },
            {
                "name": "Animal Planet",
                "cat": "history",
                "url": "http://hlstv.kem.211.ru/239.211.211.34/stream.m3u8",
                "channel": 27
            },
            {
                "name": "Nat Geo",
                "cat": "history",
                "url": "http://hlstv.kem.211.ru/239.211.211.40/stream.m3u8",
                "channel": 45
            },
            {
                "name": "Viasat History",
                "cat": "history",
                "url": "http://stream.euroasia.lfstrm.tv/viasat_history/1/index.m3u8",
                "channel": 37
            },
            {
                "name": "https://www.radioparadise.com/m3u/mp3-192.m3u",
                "cat": "history",
                "url": "https://www.radioparadise.com/m3u/mp3-192.m3u",
                "channel": 13
            },
            {
                "name": "\u0420\u0430\u0434\u0438\u043e \u041c\u0430\u044f\u043a",
                "cat": "history",
                "url": "http://icecast.vgtrk.cdnvideo.ru/mayakfm_mp3_192kbps",
                "channel": 24
            },
            {
                "name": "Investigation Discovery",
                "cat": "history",
                "url": "http://91.204.199.145:8000/play/a02x/index.m3u8",
                "channel": 28
            },
            {
                "name": "Relax FM",
                "cat": "history",
                "url": "http://ic2.101.ru:8000/v13_1?setst=094548200140236612420140625&amp;tok=75urgZKbvvpyTQMDZ1H4Hfqy5FKeKsXaPod7argnUF%2BwRqI%2Fy3MhBg%3D%3D",
                "channel": 23
            },
            {
                "name": "Viasat History",
                "cat": "history",
                "url": "http://ott-cdn.ucom.am/s70/index.m3u8",
                "channel": 15
            },
            {
                "name": "\u0421\u0442\u0430\u043d\u0438\u0441\u043b\u0430\u0432 \u0414\u0440\u043e\u0431\u044b\u0448\u0435\u0432\u0441\u043a\u0438\u0439: \"\u0421\u0435\u043d\u0441\u0430\u0446\u0438\u0438 \u0432 \u0430\u043d\u0442\u0440\u043e\u043f\u043e\u0433\u0435\u043d\u0435\u0437\u0435\"",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=jFRlBQnKRrk"
            },
            {
                "name": "http://ic5.101.ru:8000/a157?userid=0&setst=e5l2bv8j2v1jsagt3rtc3teoq8&tok=07790631dkVJeVFPUWNKdjRGRFp2d0tySWJST3JWQy8yVnphbHVTL3R3QmJJeEZ1WjEvY3ViV3RtUjJrZ3UrVWFualdDVA%3D%3D2",
                "cat": "history",
                "url": "http://ic5.101.ru:8000/a157?userid=0&setst=e5l2bv8j2v1jsagt3rtc3teoq8&tok=07790631dkVJeVFPUWNKdjRGRFp2d0tySWJST3JWQy8yVnphbHVTL3R3QmJJeEZ1WjEvY3ViV3RtUjJrZ3UrVWFualdDVA%3D%3D2",
                "channel": 29
            },
            {
                "name": "12. \u0421\u043e\u0437\u0434\u0430\u043d\u0438\u0435 \u0441\u0430\u0439\u0442\u0430 \u043d\u0430 Node.js, Express, MongoDB | \u0420\u0435\u0430\u043b\u0438\u0437\u0443\u0435\u043c \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044e",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=NDUKqVWIyo4"
            },
            {
                "name": "\u041c\u0438\u0445\u0430\u0438\u043b \u041d\u0438\u043a\u0438\u0442\u0438\u043d: \"\u041c\u0435\u0441\u0442\u043e \u043f\u0440\u043e\u0438\u0441\u0445\u043e\u0436\u0434\u0435\u043d\u0438\u044f \u0436\u0438\u0437\u043d\u0438. \u041f\u0435\u0440\u0432\u0438\u0447\u043d\u044b\u0439 \u0431\u0443\u043b\u044c\u043e\u043d, \u043f\u0438\u0446\u0446\u0430 \u0438 \u043c\u0430\u0439\u043e\u043d\u0435\u0437\"",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=o76vD_u6uNw"
            },
            {
                "name": "\u0410\u043d\u0434\u0440\u0435\u0439 \u0416\u0443\u0440\u0430\u0432\u043b\u0435\u0432: \"\u041a\u0430\u043a \u0431\u0430\u043a\u0442\u0435\u0440\u0438\u0438 \u0441\u043e\u0437\u0434\u0430\u043b\u0438 \u0430\u0442\u043c\u043e\u0441\u0444\u0435\u0440\u0443 \u0438 \u0432\u0441\u0451 \u043f\u0440\u043e\u0447\u0435\u0435 [4000-550 \u043c\u043b\u043d \u043b\u0435\u0442 \u043d\u0430\u0437\u0430\u0434]\"",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=7-oUVQn3yrQ"
            },
            {
                "name": "\u041c\u0438\u0445\u0430\u0438\u043b \u041d\u0438\u043a\u0438\u0442\u0438\u043d: \"\u0417\u0430\u0440\u043e\u0436\u0434\u0435\u043d\u0438\u0435 \u0436\u0438\u0437\u043d\u0438 \u043d\u0430 \u0417\u0435\u043c\u043b\u0435 \u0438 \u0434\u0440\u0443\u0433\u0438\u0445 \u043f\u043b\u0430\u043d\u0435\u0442\u0430\u0445\"",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=j8EWEeav42Q"
            },
            {
                "name": "\u041c\u0438\u0445\u0430\u0438\u043b \u041d\u0438\u043a\u0438\u0442\u0438\u043d: \"\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u0444\u043e\u0442\u043e\u0441\u0438\u043d\u0442\u0435\u0437\u0430, \u0438\u043b\u0438 \u043a\u0442\u043e \u0441\u0434\u0435\u043b\u0430\u043b \u043d\u0435\u0431\u043e \u0433\u043e\u043b\u0443\u0431\u044b\u043c\".",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=eXc1eXbJBIU"
            },
            {
                "name": "\u0410\u043d\u0442\u0438-\u0412\u0438\u0442\u0442\u0435. \u041a\u0430\u043a \u0420\u043e\u0441\u0441\u0438\u0439\u0441\u043a\u0430\u044f \u0438\u043c\u043f\u0435\u0440\u0438\u044f \u0440\u0443\u0445\u043d\u0443\u043b\u0430 \u0432 \u043f\u0440\u043e\u043f\u0430\u0441\u0442\u044c. \u0424\u0451\u0434\u043e\u0440 \u041b\u0438\u0441\u0438\u0446\u044b\u043d",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=i63w0xL87uA"
            },
            {
                "name": "\u041d\u0435 \u0444\u0430\u043a\u0442! \u0412\u0435\u0447\u043d\u0430\u044f \u0436\u0438\u0437\u043d\u044c",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=882wyVeW9_U"
            },
            {
                "name": "\u0414\u0438\u0441\u043a\u0443\u0441\u0441\u0438\u044f \"\u0412\u0438\u0440\u0443\u0441 \u0436\u0438\u0437\u043d\u0438. \u041c\u043e\u0436\u0435\u043c \u043b\u0438 \u043c\u044b \u0437\u0430\u043d\u0435\u0441\u0442\u0438 \u0436\u0438\u0437\u043d\u044c \u043d\u0430 \u0434\u0440\u0443\u0433\u0438\u0435 \u043f\u043b\u0430\u043d\u0435\u0442\u044b?\"",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=e-AUCrmAyRo"
            },
            {
                "name": "\"\u0412\u043e\u0437\u043c\u043e\u0436\u043d\u0430 \u043b\u0438 \u0436\u0438\u0437\u043d\u044c \u0431\u0435\u0437 \u0432\u043e\u0434\u044b \u0438 \u0436\u0438\u0437\u043d\u044c \u0431\u0435\u0437 \u0443\u0433\u043b\u0435\u0440\u043e\u0434\u0430?\" \"\u0413\u0438\u043f\u0435\u0440\u0438\u043e\u043d\", 27.09.16",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=3DRSf0q-i4M"
            },
            {
                "name": "\u041f\u043e\u0431\u0435\u0433\u0443\u0442 \u0432\u0441\u043b\u0435\u0434 \u0437\u0430 \u042f\u043d\u0443\u043a\u043e\u0432\u0438\u0447\u0435\u043c \u0438 \u041a\u043e\u043b\u043e\u043c\u043e\u0439\u0441\u043a\u0438\u043c. \u0420\u0443\u0441\u043b\u0430\u043d \u0411\u043e\u0440\u0442\u043d\u0438\u043a",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=917XT8ch1h0"
            },
            {
                "name": "\u041f\u043e\u0431\u0435\u0434\u0430 \u041fopo\u0448\u0435\u043d\u043a\u043e! \u041e\u0438\u0306, \u0442\u043e ec\u0442\u044c \u0422\u0438\u043co\u0448e\u043d\u043a\u043e!",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=JdKqhe7-YUk"
            },
            {
                "name": "\u041c\u043e\u0441\u043a\u0432\u0430 \u2014 \u041a\u0438\u0435\u0432 \u2014 \u041c\u043e\u0441\u043a\u0432\u0430 (\u0414. \u0414\u0436\u0430\u043d\u0433\u0438\u0440\u043e\u0432 , \u0411. \u041a\u0430\u0433\u0430\u0440\u043b\u0438\u0446\u043a\u0438\u0439)",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=EQOJP9QTvio"
            },
            {
                "name": "\u041c\u0443\u0442\u043d\u043e\u0435 \u0434\u0435\u043b\u043e \u0411\u0430\u0431\u0447\u0435\u043d\u043a\u043e. \u041d\u043e\u0432\u0430\u044f \"\u0436ep\u0442\u0432a\"",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=S9LEpT2W-IY"
            },
            {
                "name": "\u041e\u043b\u044c\u0433\u0430 \u0424\u0438\u043b\u0430\u0442\u043e\u0432\u0430: \u041a\u0430\u043a \u0438\u0437\u0443\u0447\u0430\u044e\u0442 \u043a\u043e\u0441\u0430\u0442\u043e\u043a?",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=rR9r4BK29II"
            },
            {
                "name": "\u041c\u0438\u0445\u0430\u0438\u043b \u041b\u0435\u0431\u0435\u0434\u0435\u0432: \"\u0418\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441 \u043c\u0435\u0436\u0434\u0443 \u043c\u043e\u0437\u0433\u043e\u043c \u0438 \u043a\u043e\u043c\u043f\u044c\u044e\u0442\u0435\u0440\u043e\u043c\"",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=7gwb6TW5D6Q"
            },
            {
                "name": "\u0411\u043e\u0440\u0438\u0441 \u0428\u0442\u0435\u0440\u043d: \"\u0417\u043e\u043e\u043f\u0430\u0440\u043a \u0447\u0435\u0440\u043d\u044b\u0445 \u0434\u044b\u0440\"",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=r8cyGXHGiUs"
            },
            {
                "name": "\u0428\u043e\u043a! \u041c\u0430\u0442\u0435\u043c\u0430\u0442\u0438\u043a \u0441\u0434\u0435\u043b\u0430\u043b \u044d\u0442\u043e! \u0425\u0438\u043c\u0438\u044f/\u041c\u0430\u0442\u0435\u043c\u0430\u0442\u0438\u043a\u0430 \u2013\u00a0\u041f\u0440\u043e\u0441\u0442\u043e",
                "cat": "history",
                "url": "https://www.youtube.com/watch?v=Byw49v8uAPo"
            },
            {
                "name": "\u0418\u041d\u0422\u0415\u0420",
                "cat": "history",
                "url": "http://176.120.119.93:805/72/index.m3u8",
                "channel": 47
            },
            {
                "name": "\u041d\u0430\u0443\u043a\u0430 2.0",
                "cat": "history",
                "url": "http://172.31.254.110:5000/c36",
                "channel": 10
            },
            {
                "name": "\u0420\u043e\u0441\u0441\u0438\u044f 24",
                "cat": "history",
                "url": "http://ott-cdn.ucom.am/s21/index.m3u8",
                "channel": 11
            }
        ]
        ;
        return {
            renderChannels() {
                const channels = [];
                for (const h of history) {
                    channels.push(new (class Channels implements props.Controller {
                        public readonly name = "";
                        public readonly online = true; // Always online
                        public get properties(): props.Property<any>[] {
                            return [
                                props.newWritableProperty<string>("Канал", h.name, new props.SpanHTMLRenderer()),
                                Button.create("Play", () => that.kindle.playURL(h.url)),
                            ];
                        } 
                    }));
                }
                return channels;
            }
        }
    }

    private get controllers(): props.Controller[] {
        const dynPropsArray = Array.from(this.dynamicControllers.values());
        dynPropsArray.sort((a, b) => a.id == b.id ? 0 : (a.id < b.id ? -1 : 1));

        return Array.prototype.concat([ 
            this.sleepAt.controller,
            this.wakeAt.controller,
            this.timer.controller,
            this.ctrlControlOther,
            this.ctrlGPIO, 
            this.miLight, 
            this.kindle, 
            this.nexus7 
        ], 
        dynPropsArray,
        this.channelsHistory.renderChannels()
        );
    }

    private simpleCmd(prefixes: string[][], showName: string, action: () => void): IRKeysHandler {
        return {
            partial: arr => {
                if (prefixes.some(prefix => util.arraysAreEqual(prefix, arr))) {
                    return 0; // Accept immediatelly
                }

                if (prefixes.some(prefix => util.arraysAreEqual(prefix.slice(0, arr.length), arr))) {
                    return 1500; // Wait for cmd to complete
                }
                return null;
            },
            complete: arr => {
                this.allInformers.runningLine(showName);
                action();
            } 
        };
    }

    private createPowerOnOffTimerKeys(prefix: string[], showName: string, valueName: string, action: (dd: number) => void): IRKeysHandler {
        return {
            partial: arr => {
                const ret = util.isKeyAndNum(prefix, arr);
                if (ret) {
                    if (arr.length == prefix.length) {
                        this.allInformers.staticLine(showName);
                    } else {
                        this.allInformers.staticLine(util.numArrToVal(arr.slice(prefix.length)) + valueName);
                    }
                    return 1500;
                } else {
                    return null; // We didn't recognize the command
                }
                
            },
            complete: arr => {
                const dd = util.numArrToVal(arr.slice(prefix.length));
                action(dd);
            } 
        };
    }

    private irKeyHandlers: IRKeysHandler[] = [
        this.createPowerOnOffTimerKeys(['power'], "Выкл", "мин", (dd) => {
            this.sleepAt.fireInSeconds(dd * 60);
        }),
        this.createPowerOnOffTimerKeys(['power', 'power'], "Вкл", "мин", (dd) => {
            this.wakeAt.fireInSeconds(dd * 60);
        }),
        this.createPowerOnOffTimerKeys(['power', 'power', 'power'], "Таймер", "мин", (dd) => {
            this.timer.fireInSeconds(dd * 60);
        }),
        this.createPowerOnOffTimerKeys(['power', 'power', 'power', 'power'], "Микро", "сек", (dd) => {
            this.timer.fireInSeconds(dd);
        }),
        this.createPowerOnOffTimerKeys(['ent'], "Канал", "", (dd) => {
            this.allInformers.runningLine("Включаем " + dd);
        }),
        this.simpleCmd([['fullscreen']], "MiLight", () => {
            this.miLight.switchOn.switch(!this.miLight.switchOn.get());
        }),
        this.simpleCmd([['n0', 'n1'], ["record"]], "Лампа на шкафу", () => {
            this.r1.switch(!this.r1.get());
        }),
        this.simpleCmd([['n0', 'n2']], "Колонки", () => {
            this.r2.switch(!this.r2.get());
        }),
        this.simpleCmd([['n0', 'n3'], ['stop']], "Коридор", () => {
            this.r3.switch(!this.r3.get());
        }),
        this.simpleCmd([['n0', 'n4'], ['time_shift']], "Потолок", () => {
            this.r4.switch(!this.r4.get());
        }),
        this.simpleCmd([['n0', 'n5'], ['av_source'], ['mts']], "Потолок на кухне", () => {
            this.toggleRelay('KitchenRelay', 0);
        }),
        this.simpleCmd([['n0', 'n6'], ['clear'], ['min']], "Лента на кухне", () => {
            this.toggleRelay('KitchenRelay', 1);
        }),

        // Sound controls
        (() => {
            return {
                partial: arr => {
                    const allAreKeyControls = arr.length > 0 && arr.every(k => k === 'volume_up' || k === 'volume_down');
                    if (allAreKeyControls) {
                        const reportValue = (v: number) => this.allInformers.staticLine(String.fromCharCode(0xe000) + 
                            Math.floor(v) + "%");

                        reportValue(this.kindle.volume.get());
                        const last = arr[arr.length-1];
                        this.kindle.changeVolume(last == 'volume_up').then(
                            () => this.kindle.getVolume().then(reportValue));
                        return 2500;
                    } else {
                        return null; // We didn't recognize the command
                    }
                    
                },
                complete: arr => {
                    console.log("Nothing to do");
                }     
            } as IRKeysHandler;
        })(),
    ];

    public toggleRelay(internalName: string, index: number): void {
        const kitchenRelay = this.findDynController(internalName);
        if (kitchenRelay) {
            kitchenRelay.relays[index].switch(!kitchenRelay.relays[index].get());
        }       
    }

    public static confFileName() {
        return os.homedir() + '/nodeserver.stored.conf.json';
    }

    private _lastSavedConfHash = "";
    private saveConf() {
        util.delay(1).then(() => {
            const hasho = crypto.createHash('md5');

            const toSerialize = Object.keys(this)
                .filter(prop => typeof((this as any)[prop]) == "object" && "toJsonType" in (this as any)[prop]);
            
            const resJson: any = {};
            toSerialize.forEach(prop => {
                resJson[prop] = (this as any)[prop].toJsonType();
                hasho.update(resJson[prop].toString());
            });

            const thisSavedHash = hasho.digest("hex");
            if (thisSavedHash != this._lastSavedConfHash) {
                fs.writeFileSync(App.confFileName(), JSON.stringify(resJson));
                this._lastSavedConfHash = thisSavedHash;
            }
        });
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
                    try {
                        const objData = JSON.parse(data);
                        const controller = this.dynamicControllers.get(ip);

                        // It might be hello message
                        if ('type' in objData && objData.type == 'hello') {
                            const hello = objData as Hello;
                            const mapIRs = new Map<string, { 
                                lastRemote: number,
                                seq: string[],
                                handler?: IRKeysHandler,
                                wait: number
                            }>();

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
                                },
                                onIRKey: (remoteId: string, keyId: string) => {
                                    var _irState;
                                    if (!mapIRs.has(remoteId)) {
                                        _irState = { lastRemote: 0, seq: [], wait: 1500 };
                                        mapIRs.set(remoteId, _irState);
                                    } else {
                                        _irState = mapIRs.get(remoteId);
                                    }

                                    const irState = _irState!;
                                    const now = new Date().getTime();
                                    if (now - irState.lastRemote > 200) {
                                        // console.log(remoteId, keyId, (now - irState.lastRemote) );
                                        irState.seq.push(keyId);
                                        var toHandle;
                                        for (const handler of this.irKeyHandlers) {
                                            const toWait = handler.partial(irState.seq);
                                            if (toWait != null) {
                                                toHandle = handler;
                                                irState.wait = toWait;
                                            }
                                        }
                                        if (toHandle) {
                                            irState.handler = toHandle;
                                        } else {
                                            console.log('Ignored ' + irState.seq.join(","));
                                            irState.seq = [];
                                        }

                                        util.delay(irState.wait).then(() => {
                                            const now = new Date().getTime();
                                            if ((now - irState.lastRemote) >= irState.wait) {
                                                // Go!
                                                if (irState.handler && irState.handler.partial(irState.seq) !== null) {
                                                    irState.handler.complete(irState.seq);
                                                }

                                                irState.seq = [];
                                                irState.lastRemote = now;
                                            }
                                        });
                                    }
                                    irState.lastRemote = now;
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
                    } catch (e) {
                        console.error('Can not process message:', data);
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
        const propChangedMap = this.onlineControllers.map((ctrl, ctrlIndex) => {
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
            util.wrapToHTML("body", this.onlineControllers.map((ctrl) => {
                return ctrl.name + "<br/>" + ctrl.properties.map((prop: props.Property<any>): string => {
                        let res = "";

                        res = prop.htmlRenderer.body(prop);

                        return res;
                    }).join("&nbsp;\n");
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