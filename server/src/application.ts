import * as express from 'express'
import * as http from 'http';
import * as WebSocket from 'ws';
// import * as stream from "stream";
import * as fs from "fs";
import { homedir } from "os";
import * as nodeutil from "util";
import * as path from "path";
import * as util from "util";
import * as dgram from "dgram";
import * as crypto from 'crypto';
import * as querystring from 'querystring';

import * as curl from "./http.util";
import { HourMin, isHourMin, nowHourMin, hourMinCompare, toSec, runShell, Config, newConfig, arraysAreEqual, emptyDisposable, getFirstNonPrefixIndex, isNumKey, numArrToVal, toFixedPoint, tempAsString, doAt, parseOr, wrapToHTML, splitLines, toHourMinSec, toHMS  } from "./common.utils";
import { getYoutubeInfo, parseYoutubeUrl, getYoutubeInfoById } from "./youtube.utils";
import { Relay, Controller, newWritableProperty, CheckboxHTMLRenderer, SliderHTMLRenderer, Property, ClassWithId, SpanHTMLRenderer, Button, WritablePropertyImpl, SelectHTMLRenderer, isWriteableProperty, StringAndGoRendrer, ImgHTMLRenderer, Disposable, OnOff, HTMLRederer, HourMinHTMLRenderer } from "./properties";
import { TabletHost, Tablet, adbClient, Tracker, Device } from "./android.tablet";
import { CompositeLcdInformer } from './informer.api';
import { ClockController, ClockControllerCommunications, Hello, ClockControllerEvents, AnyMessageToSend } from './esp8266.controller';

import { Msg, MsgBack, ScreenOffset, ScreenContent } from "./../generated/protocol_pb";
import { doWithTimeout, delay } from './common.utils';
import { encodeStr } from './http.util';
import { addPullup } from './spreadsheet.utils';

type WebPageType = 'web' | 'lights' | 'settings' | 'iptv' | 'ir' | 'actions' | 'log';

class GPIORelay extends Relay {
    private _init: Promise<void>;
    private _modeWasSet: boolean = false;
    static readonly gpioCmd = "/root/WiringOP/gpio/gpio";

    constructor(readonly name: string, public readonly pin: number, private readonly conf: Config<{ relays: boolean[] }>, private readonly index: number, location: string) {
        super(name, location);

        this.conf.read().then(conf => this.setInternal(conf.relays[this.index]));

        if (GPIORelay.gpioInstalled()) {
            this._init = runShell(GPIORelay.gpioCmd, ["-1", "read", "" + this.pin])
                .then((str) => {
                    this.setInternal(str.startsWith("0"));
                    return void 0;
                })
                .catch(err => console.log(err.errno))
        } else {
            this._init = Promise.resolve(void 0);
        }
    }

    private static gpioCmdInstalled?: boolean;

    static gpioInstalled(): boolean {
        if (GPIORelay.gpioCmdInstalled === undefined) {
            GPIORelay.gpioCmdInstalled = fs.existsSync(GPIORelay.gpioCmd);
        }
        return GPIORelay.gpioCmdInstalled;
    }

    switch(on: boolean): Promise<void> {
        // console.trace("GPIO switch ", on);
        if (!this._modeWasSet) {
            this._init = this._init.then(() =>
                runShell(GPIORelay.gpioCmd, ["-1", "mode", "" + this.pin, "out"])
                    .then(() => Promise.resolve(void 0))
                    .catch(err => console.log(err.errno)));
        }

        return this._init.then(() => {
            return runShell(GPIORelay.gpioCmd, ["-1", "write", "" + this.pin, on ? "0" : "1"])
                .then(() => {
                    this.setInternal(on);
                    return this.conf.change(d => { d.relays[this.index] = on });
                })
                .catch(err => console.log(err.errno));
        });
    }
}

interface WeatherError400 {
    cod: 400|401|402|403|404|405|406|407|408|409|410|411|412|413|414|415|416|417|418|419|421|422|423|424|426|428|429|431|449|451|499;
    message: string;
}

interface WeatherError500 {
    cod: 500|501|502|503|504|505|506|507|508|509|510|511|520|521|522|523|524|525|526;
    message: string;
}

interface WeatherInfo {
    cod: 200;
    weather: { 
        id: number,
        main: string,
        description: string,
        icon: string
    } [];
    base: string;
    main: { 
        temp: number,
        pressure: number,
        humidity: number,
        temp_min: number,
        temp_max: number,
        sea_level: number,
        grnd_level: number 
    };
    wind: { speed: number, deg: number };
    rain: { '3h': number };
    clouds: { all: number };
    dt: number;
    sys: { 
        message: number,
        country: string,
        sunrise: number,
        sunset: number 
    },
    id: number;
    name: string;
    coord: { lon: number, lat: number }
};

interface MiLightBulbState {
    on: boolean;
    allWhite: boolean;
    brightness: number;
    hue: number;
}

class MiLightBulb implements Controller {
    readonly name = "MiLight";
    readonly online = true;
    readonly ip = "192.168.121.35";
    readonly port = 8899;

    constructor(private config: Config<MiLightBulbState>) {
        config.read().then(conf => {
            this.switchOn.setInternal(conf.on);
            this.allWhite.setInternal(conf.allWhite);
            this.brightness.setInternal(conf.brightness);
            this.hue.setInternal(conf.hue);
        })
    }

    public readonly switchOn = new (class MiLightBulbRelay extends Relay {
        constructor(
            readonly pThis: MiLightBulb) {
            super("MiLight", "Комната");
        }

        public switch(on: boolean): Promise<void> {
            return this.pThis.config.change(conf => conf.on = on)
                .then(() => this.pThis.send([on ? 0x42 : 0x46, 0x00, 0x55])
                    .then(() => this.setInternal(on)));
        }
    })(this);

    public readonly allWhite = newWritableProperty<boolean>("All white", false, new CheckboxHTMLRenderer(), {
        onSet: (val: boolean) => {
            this.config.change(conf => conf.allWhite = val).then(() => {
                if (val) {
                    this.send([0xC2, 0x00, 0x55]);
                } else {
                    this.send([0x40, (0xff * this.hue.get() / 100), 0x55]);
                }
            });
        }});

    public readonly brightness = newWritableProperty<number>("Brightness", 50, new SliderHTMLRenderer(), {
        onSet: (val: number) => {
            this.config.change(conf => conf.brightness = val).then(() => {
                this.send([0x4E, 0x2 + (0x15 * val / 100), 0x55]);
            });
        },
        preSet: (val: number) => {
            return Math.min(Math.max(val, 0), 100);
        }
    });

    public readonly hue = newWritableProperty<number>("Hue", 50, new SliderHTMLRenderer(), {
        onSet: (val: number) => {
            this.config.change(conf => { conf.hue = val; conf.allWhite = false; }).then(() => {
                this.allWhite.set(false);
            });
        }});

    public properties() {
        return [this.switchOn, this.allWhite, this.brightness, this.hue] as Property<any>[]
    };

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

interface SunrizeRes {
    status: string;
}

interface SunrizeError extends SunrizeRes {
    status: 'Error';
}

interface SunrizeDate extends SunrizeRes { 
    status: 'OK';
    results: { 
        sunrise: string; // '2019-01-31T05:04:02+00:00',
        sunset: string; // '2019-01-31T14:49:54+00:00',
        solar_noon: string; // '2019-01-31T09:56:58+00:00',
        day_length: number; // 35152, in seconds
        civil_twilight_begin: string; // '2019-01-31T04:32:49+00:00',
        civil_twilight_end: string; // '2019-01-31T15:21:07+00:00',
        nautical_twilight_begin: string; // '2019-01-31T03:57:36+00:00',
        nautical_twilight_end: string; // '2019-01-31T15:56:20+00:00',
        astronomical_twilight_begin: string; // '2019-01-31T03:23:11+00:00',
        astronomical_twilight_end: string; // '2019-01-31T16:30:45+00:00' 
    };
}

type RemoteEnd = {
    controller: ClockController;
    remoteId: string;
}

interface IRKeysHandler {
    remote?: string;
    /**
     * This method should check array and return milliseconds before accepting
     */
    partial(from: RemoteEnd, arr: string[], final: boolean, timestamps: number[]): number | null;
    /**
     * Accept the command
     */
    complete(from: RemoteEnd, arr: string[], timestamps: number[]): void;
}

type ChannelType = 'Url' | 'Youtube';

type PullUp = {
    day: string;
    count: number;
}

type IRKey = {
    periods: number[];
    keyName: string;
    remoteName: string;
}

interface Channel {
    name: string;
    cat?: string;
    url: string;
    source?: string;
    channel?: number;
}

function getType(c: Channel): ChannelType{
    const ytbInfo = parseYoutubeUrl(c.url);
    if (ytbInfo) {
        return 'Youtube';
    }
    return 'Url';
}

function compareChannels(c1: Channel, c2: Channel): number {
    const t1 = getType(c1);
    const t2 = getType(c2);
    if (t1 !== t2) {
        return t1.localeCompare(t2);
    } else if (t1 === "Url") {
        return c1.url.localeCompare(c2.url);
    } else if (t1 === "Youtube") {
        return c1.url.localeCompare(c2.url);
    }
    return 0; // Should never happen
}

type TimerProp = { val: HourMin, controller: Controller, fireInSeconds: (sec: number) => void };

type Labeled = {
    lbl: string;
};
type Action = Labeled & {
    action: ((from: RemoteEnd) => void) | (() => void);
};
type SubMenu = Labeled & {
    submenu: () => Menu[];
};
type Menu = (Action | SubMenu);

type KeyType = {
    [k in 'menu' | 'up' | 'down' | 'left' | 'right']: string;
};

type MenuKeysType = {
    [remote: string]: KeyType;
};
const menuKeys = {
    'CanonCamera': { menu: 'set', up: 'up', down: 'down', left: 'left', right: 'right' },
    'transcendPhotoFrame': { menu: 'ok', up: 'up', down: 'down', left: 'left', right: 'right' },
    'prologicTV': { menu: 'ent', up: 'channel_up', down: 'channel_down', left: 'volume_down', right: 'volume_up' },
    'tvtuner': { menu: 'n5', up: 'n2', down: 'n8', left: 'n4', right: 'n6' },
} as MenuKeysType;

type SoundType = 'lightOn' | 'lightOff' | 'alarmClock' | 'timerClock' | 'pullUp' | 'pullUpTen';
type TimersType = 'dayBeginsAt' | 'dayEndsAt';

type SoundAction = {
    index: number;
    volume: number;
};

function isSoundAction(x: any): x is SoundAction {
    return typeof(x) === 'object' && 'index' in x && 'volume' in x;
}

type SleepType = 'sleepAt' | 'wakeAt' | 'timer1At';

type SleepSettings = {
    [P in SleepType]: HourMin;
};

const defSleepSettings: SleepSettings = {
    sleepAt: { h: -1, m: -1},
    wakeAt: { h: -1, m: -1},
    timer1At: { h: -1, m: -1},
}

type KeysSettings = {
    weatherApiKey: string;
    youtubeApiKey: string;
    spreadsheetsApiKey: string;
    simulateHostAtHome: boolean;
} & {
    [P in SoundType]: SoundAction|null;
} & {
    [P in TimersType]: HourMin;
};

const defKeysSettings: KeysSettings = { 
    weatherApiKey: "",
    youtubeApiKey: "",
    spreadsheetsApiKey: "",
    simulateHostAtHome: false,
    lightOn: { index: 0, volume: 50 },
    lightOff: { index: 0, volume: 50 },
    alarmClock: { index: 0, volume: 50 },
    timerClock: { index: 0, volume: 50 },
    pullUp: { index: 0, volume: 50 },
    pullUpTen: { index: 0, volume: 50 },
    dayBeginsAt: { h: 7,  m: 0},
    dayEndsAt: { h: 23, m: 0},
}

function clrFromName(name: string) {
    const x = crypto.createHash('md5').update(name).digest("hex").substr(0, 6);
    return "#" + x.split(/(.{2})/).filter(O=>O).map(x => {
        // console.log(x, (Number.parseInt(x, 16));
        const xx = '00' + (255 - Math.trunc(Number.parseInt(x, 16) / 2)).toString(16);
        return xx.slice(xx.length - 2);
    }).join('');
}

const UDP_SERVER_PORT = 8081;

type Log = {
    d: Date;
    s: string;
    e?: Error;
}

class App implements TabletHost {
    public expressApi: express.Express;
    public server: http.Server;
    public readonly wss: WebSocket.Server;
    public currentTemp?: number;
    public isSleeping: boolean = false;

    private gpioRelays = newConfig({ relays: [false, false, false, false] }, "relays");

    private r1 = new GPIORelay("Лента на шкафу", 38, this.gpioRelays, 0, "Комната");
    // private r2 = new GPIORelay("Розетка 0", 40, this.gpioRelays, 1, "Комната");
    // private r3 = new GPIORelay("Коридор", 36, this.gpioRelays, 2, "Коридор");
    private r4 = new GPIORelay("Лампа на шкафу", 32, this.gpioRelays, 3, "Комната");
    // private r5 = new GPIORelay("R5", 37, this.gpioRelays, 4);
    // private r6 = new GPIORelay("R6", 35, this.gpioRelays, 5);
    // private r7 = new GPIORelay("R7", 33, this.gpioRelays, 6);
    // private r8 = new GPIORelay("R8", 31, this.gpioRelays, 7);

    private allowRenames = false;

    private clearGlobalLog = Button.create("Clear log", () => {
        this.globalLog.setInternal([]);
        this.log("Log was cleared."); // This will also refresh web part
    });
    private globalLog = newWritableProperty<Log[]>("", [],
        new SpanHTMLRenderer<Log[]>(x => "<br/>" + 
            x.map(i => {
                const r = [ "<span style='color: green; font-size: smaller'>" + toHMS(i.d) + " </span>" ];
                r.push("&nbsp;<span>" + encodeStr(i.s ?? "") + "</span>");
                if (i.e && i.e.stack) {
                    r.push('<br/>');
                    for (const sl of i.e.stack.split(/\r\n|\r|\n/gi)) {
                        r.push("&nbsp;<span style='color:red'>" + encodeStr(sl) + "</span><br/>");
                    }
                }
                return r.join("");
            }).reverse().join("<br/>")
        ));

    private log(str: string, stack?: boolean): void {
        if (typeof(str) != "string") {
            str = "UNKNOWN TYPE " + str;
            stack = true;
        }
        const sa = this.globalLog.get();
        sa.push({ s: str, d: new Date(), e: (stack ? new Error() : undefined) });
        this.globalLog.setInternal(sa);
        delay(300).then(() => {
            this.reloadAllWebClients('log');
        });
    }

    private ctrlGPIO = {
        name: "Комната",
        properties: () => [this.r1, /*this.r2,*/ this.r4, /* this.r3, this.r5, this.r6, this.r7, this.r8 */ ]
    }

    private dynamicControllers: Map<string, ClockController> = new Map();
    
    findDynController(internalName: string): ClockController | undefined {
        for (const ctrl of this.dynamicControllers.values()) {
            if (ctrl.internalName == internalName) {
                return ctrl;
            }
        }
        return undefined;
    }


    // Show the message on all informers
    public allInformers: CompositeLcdInformer = new CompositeLcdInformer();

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


    private miLightNow: MiLightBulbState = { on: false, brightness: 0, hue: 0, allWhite: true };
    private miLightState = newConfig<MiLightBulbState>(this.miLightNow, "miLight");

    private readonly miLight = new MiLightBulb(this.miLightState);

    private readonly kindle: Tablet = new Tablet('192.168.121.166:5555', 'Kindle', this, true);
    private readonly nexus7: Tablet = new Tablet('00eaadb6', 'Nexus', this, false);
    private readonly nexus7TCP: Tablet = new Tablet('192.168.121.172:5555', 'Nexus TCP', this, true);

    private readonly tablets: Map<string, Tablet> = new Map(
        [this.kindle, this.nexus7, this.nexus7TCP].map(t => [t.id, t] as [string, Tablet])
    );

    private readonly lat = 44.9704778;
    private readonly lng = 34.1187681;

    private sleepSettings = newConfig<SleepSettings>(defSleepSettings, "timers");
    private keysSettings = newConfig<KeysSettings>(defKeysSettings, "keys");

    private createTimer(name: string, 
        confName: SleepType, 
        onFired: ((d: HourMin, sound?: SoundType) => void),
        sound?: SoundType): TimerProp {

        this.sleepSettings.read().then(conf => {
            // Prop was read, let's set props
            setNewValue(conf[confName]);
        })
       
        const tProp = newWritableProperty<HourMin>("", this.sleepSettings.last()[confName], 
            new HourMinHTMLRenderer(), 
            { 
                onSet: (val: HourMin) => {
                    onDateChanged();
                }
            });

        const onDateChanged = () => {
            setNewValue(tProp.get());
            orBeforeProp.setInternal(1);
        };
            
        const inProp = newWritableProperty<number|undefined>("через", 0,
            new SpanHTMLRenderer<number>(n => n === undefined ? "" : toHourMinSec(n)));

        const min = 60;
        const hour = 60 * min;
        const timerIn: string[] =
            ["never", "atdate"].concat(
                [1, 5, 10, 15, 20, 30, 45, min, 2 * min, 3 * min, 5 * min, 10 * min, 15 * min, 20 * min, 30 * min, 45 * min,
                    hour, 2 * hour, 3 * hour, 4 * hour, 5 * hour, 8 * hour, 12 * hour, 23 * hour].map(n => "val" + n));

        const orBeforeProp: WritablePropertyImpl<number> = newWritableProperty<number>(
            "через",
            0,
            new SelectHTMLRenderer<number>(Array.from({ length: timerIn.length }, (e, i) => i), _n => {
                // console.log(_n);
                const n = timerIn[_n];
                if (n.startsWith("val")) {
                    return toHourMinSec(+n.slice(3));
                } else if (n === "never") {
                    return "никогда";
                } else if (n === "atdate") {
                    return "в момент";
                }
                return "";
            }),
            { onSet: (_n: number) => {
                this.log('onSet');
                const n = timerIn[_n];
                if (n.startsWith("val")) {
                    that.fireInSeconds(+n.slice(3));
                } else if (n === "never") {
                    setNewValue({ h: -1, m: -1, s: -1});
                } else if (n === "atdate") {
                    onDateChanged();
                }
            }});
        var timers: NodeJS.Timer[] = [];
        let intervalTimer: NodeJS.Timer;

        const setNewValue = (d: HourMin) => {
            this.log(name + " --> " + d.h + ":" + d.m + ":" + d.s);
            if (hourMinCompare(d, that.val) !== 0) {
                // that.val === undefined || that.val.getTime() != d.getTime())) {
                timers.forEach(t => clearTimeout(t));
                timers = [];

                if (intervalTimer) {
                    clearInterval(intervalTimer);
                }
                if (d) {
                    intervalTimer = setInterval(() => {
                        if (that.val.h !== -1 && that.val.m !== -1) {
                            const now = toSec(nowHourMin());
                            let thatMs = toSec(that.val);
                            if (thatMs < now) {
                                // move to next day
                                thatMs += 24*60*60;
                            }
                            inProp.setInternal(thatMs - now);
                        } else {
                            inProp.setInternal(undefined);
                        }
                    }, 1000);
                } else {
                    inProp.setInternal(undefined);
                }


                that.val = d;
                if (that.val.h !== -1 && that.val.m !== -1) {
                    const now = toSec(nowHourMin());
                    let thatMs = toSec(that.val);
                    if (thatMs < now) {
                        // move to next day
                        thatMs += 24*60*60;
                    }

                    tProp.set(that.val);
                    orBeforeProp.setInternal(1);

                    const tt = that.val;
                    this.log('setup timer' + tt);
                    // Let's setup timer
                    timers.push(setTimeout(() => {
                        onFired(tt, sound);
                        setNewValue({ h: -1, m: -1, s: -1 });
                    }, (thatMs - now) * 1000));
                    [45, 30, 20, 15, 10, 5, 4, 3, 2, 1].forEach(m => {
                        const msB = (thatMs - now) - m*60;
                        if (msB > 0) {
                            timers.push(setTimeout(() => {
                                // 
                                this.log(m + ' минут до ' + name);
                                this.allInformers.runningLine(m + ' минут до ' + name.toLowerCase(), 3000);
                            }, msB * 1000));
                        }
                    }); 
                    const toSave = {} as Partial<SleepSettings>;
                    toSave[confName] = that.val;
                    this.sleepSettings.change(toSave);
                } else {
                    // Dropped timer 
                    tProp.setInternal({ h: -1, m: -1, s: -1 });
                    orBeforeProp.setInternal(0);
                    const toSave = {} as Partial<SleepSettings>;
                    toSave[confName] = that.val;
                    this.sleepSettings.change(toSave);
                }
            }
        }

        const that = {
            val: { h: -1, m: -1} as HourMin,
            controller: {
                name: name,
                properties: () => [
                    tProp, orBeforeProp, inProp
                ]
            },
            fireInSeconds: (sec: number) => {
                this.log('fireInSeconds' + sec);
                const d = nowHourMin();
                let x = (d.s || 0) + d.m * 60 + d.h * 3600;

                x += sec;
                x = x % (24*60*60);

                d.h = Math.floor(x / 3600) % 24;
                x -= d.h * 3600;
                d.m = Math.floor(x / 60) % 60;
                x -= d.m * 60;
                d.s = x;               

                setNewValue(d);
            }
        };
        return that;
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

    public sleepAt = this.createTimer("Выкл", "sleepAt", async (d) => {
        this.isSleeping = true;

        const clock = this.findDynController('ClockNRemote');
        if (clock) {
            clock.screenEnabledProperty.set(false);
        }

        // Turn the lights down low
        this.log('Turning off all the lights');
        for (const l of this.lights()) {
            l.switch(false);
        }

        this.kindle.stopPlaying();
        this.kindle.screenIsOn.set(false); // Turn TV off
    });

    public timer = this.createTimer("Таймер", 'timer1At', async (d, sound) => {
        this.log("Timer!");

        this.allInformers.staticLine("Время!");
/*
        const kr = this.findDynController('RelayOnKitchen');
        if (kr) {
            async function blinkKitchenStripe(stripeRelay: Relay) {
                const wasOn = stripeRelay.get();
                for (var i = 0; i < 3; ++i) {
                    stripeRelay.set(false);
                    await delay(600);
                    stripeRelay.set(true);
                    await delay(600);
                }
                stripeRelay.set(wasOn);
            }
            blinkKitchenStripe(kr.relays[1]);
            blinkKitchenStripe(this.r3);
        }
*/
        for (const c of ['ClockNRemote', 'KitchenRelay']) {
            const cr = this.findDynController(c);
            if (cr && sound) {
                this.sound(cr, sound);
            }
        }
    }, 'timerClock');

    public wakeAt = this.createTimer("Вкл", 'wakeAt', (d, sound) => {
        this.isSleeping = false;
        const wake = async () => {
            this.allInformers.runningLine("Просыпаемся...", 10000);

            this.kindle.screenIsOn.set(true);
            await delay(100)
            this.kindle.volume.set(70);
            await delay(100)
            const chan = (await this.channelsHistoryConf.read()).channels.find(c => c.channel === 1);
            if (chan) {
                await this.playChannel(this.kindle, chan);
            }

            const kr = this.findDynController('KitchenRelay');
            if (kr) {
                // kr.relays[1].switch(true);
                kr.screenEnabledProperty.set(true);
            }

            const clock = this.findDynController('ClockNRemote');
            if (clock) {
                const se = await clock.screenEnabledProperty.get();
                if (!se) {
                    clock.screenEnabledProperty.set(true);
                }
                if (sound) {
                    this.sound(clock, sound);
                }
            } 
        }
        wake();
    }, 'alarmClock');


    private pullups = newWritableProperty<number>("Сегодня", 0, new SpanHTMLRenderer());
    private ctrlPullups = {
        name: "Подтягиваний",
        properties: () => [
            this.pullups
        ]
    };

    private nowWeatherIcon = newWritableProperty<string>("", "", new ImgHTMLRenderer(40, 40));
    private nowWeather = newWritableProperty<string>("", "", new SpanHTMLRenderer());
    private ctrlWeather = {
        name: "Погода",
        properties: () => [
            this.nowWeatherIcon,
            this.nowWeather
        ]
    };

    private _freeMem = newWritableProperty<number>("Free memory", 0, new SpanHTMLRenderer(v => { return Math.floor(v) + "%";}), {
        init: (_this) => {
            let lastReportedTime = Date.now();
            let startedRebooting = false;
            setInterval(async () => {
                const minfo = await this.getMemInfo();
                const freeMem = minfo['MemAvailable']*100/minfo['MemTotal'];
                _this.set(freeMem);
                if (freeMem < 15 && (Date.now() - lastReportedTime) > 20000) {
                    lastReportedTime = Date.now();
                    this.log('Low memory: ' + freeMem);
                    this.allInformers.runningLine('На сервере мало памяти', 3000);
                }
                if (freeMem < 8 && !startedRebooting) {
                    startedRebooting = true;
                    this.allInformers.runningLine('Перегружаем сервис - осталось совсем мало памяти', 3000);
                    delay(2000).then(() => this.rebootService());
                }
            }, 5000);
        }
    });

    private ctrlControlOther = {
        name: "Другое",
        properties: () => [
            Button.create("Reboot service", () => {
                this.rebootService();
            }),
            Button.create("Reboot Orange Pi", () => runShell("reboot", [])),
            Button.createClientRedirect("TV Channels", "/tv.html"),
            Button.create("Reload TV channels", () => this.reloadM3uPlaylists()),
            Button.createClientRedirect("Lights", "/lights.html"),
            Button.createClientRedirect("Settings", "/settings.html"),
            Button.createClientRedirect("InfraRed", "/ir.html"),
            Button.createClientRedirect("Log", "/log.html"),
            newWritableProperty<boolean>("Allow renames", this.allowRenames, new CheckboxHTMLRenderer(), { onSet: (val: boolean) => {
                this.allowRenames = val;
                this.reloadAllWebClients('web');
            }}),
            Button.create("Test", () => this.test()),
            this._freeMem
        ]
    }

    private tvChannels = newConfig({ channels: [] as Channel[], lastUpdate: 0 }, "m3u_tv_channels");
    private channelsHistoryConf = newConfig({ channels: [] as Channel[] }, "tv_channels");
    private irKeysConf = newConfig({ irKeysConf: [] as IRKey[] }, "ir_keys");

    // private actions = newConfig({ actions: [] as PerformedAction[] }, "actions");

    private channelAsController(h: Channel, 
        additionalPropsBefore: Property<any>[] = [],
        additionalPropsAfter: Property<any>[] = []): Controller {
        const that = this;
        return new (class Channels implements Controller {
            public readonly name = "";
            public properties(): Property<any>[] {
                return Array.prototype.concat(
                    additionalPropsBefore,
                    newWritableProperty<string>("", 
                        {
                            'Youtube': () => "get_tv_logo?" + "ytb=" + parseYoutubeUrl(h.url)!.id,
                            'Url': () => "get_tv_channel_logo?name=" + encodeURIComponent(h.name)
                        }[getType(h)](), new ImgHTMLRenderer(40, 40)),                     
                    newWritableProperty<string>("", h.name, new SpanHTMLRenderer()),
                    that.makePlayButtonsForChannel(h.url, t => that.playChannel(t, h)), 
                    additionalPropsAfter);
            }
        })();
    }

    private allOnlineTablets(): Tablet[] {
        return Array.from(this.tablets.values()).filter(t => t.online);
    }

    private makePlayButtonsForChannel(url: string, play: (t: Tablet) => void): Button[] {
        return Array.prototype.concat(this.allOnlineTablets().map(t => 
            Button.create("Play [ " + t.shortName + " ]", () => play(t))
        ), [
            Button.createCopyToClipboard("Copy URL", url)
        ]);
    }

    private lastPressedIrKey = newWritableProperty<number[]>("Periods:", [], new SpanHTMLRenderer(
        x => (x.length + ": [" + x.map(x => x.toString()).join(', ') + "]")
    ));
    private lastPressedIrKeyRecognizedAs = newWritableProperty("Recognized as:", "", new SpanHTMLRenderer());
    private lastPressedRemote = newWritableProperty("Remote name", "", new StringAndGoRendrer("Set"), {
        onSet: (val) => this.changeIRConf()
    });
    private lastPressedKey = newWritableProperty("Key name", "", new StringAndGoRendrer("Set"), {
        onSet: (val) =>  this.changeIRConf()
    });

    private async recognizeIRKey(periods: number[]): Promise<IRKey> {
        const allKeys = (await this.irKeysConf.read()).irKeysConf;
        for (const k of allKeys) {
            let i = 0;
            for (;; ++i) {
                if (i === periods.length || i === k.periods.length || periods[i] > 30000) {
                    // Recognized!
                    return k;
                }
                const ratio = (k.periods[i] || 1) / (periods[i] || 1);
                if (ratio < 0.7 || ratio > 1.4) {
                    break; // wrong key
                }
            }
        }
        return { periods, keyName: "", remoteName: "" };
    }

    private async changeIRConf(): Promise<void> {
        const irRemote = this.lastPressedRemote.get();
        const irKey = this.lastPressedKey.get();
        const periods = this.lastPressedIrKey.get();

        const k = await this.recognizeIRKey(periods);
        if (irRemote && irKey) {
            await this.irKeysConf.change(f => {
                this.log('CHANGE IR CONF: adding' + irRemote + irKey);
                const s = new Map(f.irKeysConf.map(e => [e.remoteName + ":" + e.keyName, e]));
                if (k.keyName || k.remoteName) {
                    // Remove old
                    s.delete(k.remoteName + ":" + k.keyName);
                }
                s.set(irRemote + ":" + irKey, { periods, keyName: irKey, remoteName: irRemote });
                f.irKeysConf = Array.from(s.values());
            });
        }
    }

    private renderChannels() {
        const chToHist = new Map();
        this.channelsHistoryConf.last().channels.forEach(element => {
            if (!!element.channel) {
                chToHist.set(element.channel, element);
            }
        });

        // channelsProto contains all channels that are not used yet
        const channelsProto = Array.from({ length: 30 }, (e, i) => i).filter(ch => !chToHist.has(ch));
        return this.channelsHistoryConf.last().channels.filter(h => h).map((h, index) => {
            // If needed, add own channel
            const channels = Array.prototype.concat(h.channel ? [h.channel] : [], channelsProto) as number[];
            // Sort!
            // channels.sort((i1, i2) => i1 == i2 ? 0 : (i1 < i2 ? -1 : 1));
            
            return this.channelAsController(h, 
                [
                    newWritableProperty<number>("", (h.channel || -1),
                        new SelectHTMLRenderer<number>(channels, _n => "" + _n),
                            { onSet: (num) => {
                                this.channelsHistoryConf.change(hist => {
                                    h.channel = num;
                                })
                            }})
                ],
                Array.prototype.concat(h.channel ? [] : [
                    Button.create("Remove", () => {
                        this.channelsHistoryConf.change(hist => {
                            if (!hist.channels[index].channel) {
                                hist.channels.splice(index, 1);
                            }
                        }).then(() => {
                            this.reloadAllWebClients('web');
                        });
                    }),
                ],
                (this.allowRenames) ? [
                    newWritableProperty("New name", h.name, new StringAndGoRendrer("Rename"), { onSet: (val) => {
                        this.channelsHistoryConf.change(hist => {
                            h.name = val;
                        }).then(() => this.reloadAllWebClients('web'));
                    }}),
                ] : []));
        });
    }

    private allPropsFor: Map<WebPageType, () => Promise<Property<any>[][]>> = new Map([
        ['web', async () => this.controllers.map((ctrl) => {
            return Array.prototype.concat(
                ctrl.name ? [ newWritableProperty("", ctrl.name, new SpanHTMLRenderer()) ] : [], 
                ctrl.properties());
        })],
        ['iptv', async () => this.tvChannels.last().channels.filter(h => h).map((h, index) => {
            return Array.prototype.concat(
                [ newWritableProperty("", "" + index + ".", new SpanHTMLRenderer()) ], 
                newWritableProperty<string>("", 
                {
                    'Youtube': () => "get_tv_logo?" + "ytb=" + parseYoutubeUrl(h.url)!.id,
                    'Url': () => "get_tv_channel_logo?name=" + encodeURIComponent(h.name)
                }[getType(h)](), new ImgHTMLRenderer(40, 40)),
                [ newWritableProperty("", [h.name, h.source ? ('(' + h.source + ')') : undefined].filter(x => !!x).join(" "), new SpanHTMLRenderer()) ],
                [ newWritableProperty("", h.cat, new SpanHTMLRenderer()) ], 
                this.makePlayButtonsForChannel(h.url, t => this.playURL(t, h.url, h.name))
            );
        })],
        ['lights', async () => {
            const s: Map<string, OnOff[]> = new Map();
            return Array.from(this.lights().reduce((prev, curr) => {
                const loc = curr.location || "";
                if (!prev.has(loc)) {
                    prev.set(loc, []);
                }
                prev.get(loc)!.push(curr);
                return s;
            }, s).values());
        }],
        ['ir', async () => {
            return [
                [this.lastPressedIrKey],
                [this.lastPressedIrKeyRecognizedAs],
                [this.lastPressedKey],
                [this.lastPressedRemote],
            ];
        }],
        ['settings', async () => {
            const keys: KeysSettings = await this.keysSettings.read();
            return Object.getOwnPropertyNames(this.keysSettings.def).map((kn2) => {
                const kn = kn2 as (keyof KeysSettings);
                const v = keys[kn];
                let ret;
                if (typeof (v) === 'string') {
                    ret = [newWritableProperty(kn, keys[kn], new StringAndGoRendrer("Change"), { 
                        onSet: (val: string) => {
                            (keys as any)[kn] = val;
                            this.keysSettings.change(keys);
                        }})];
                } else if (typeof (v) === 'boolean') {
                    ret = [newWritableProperty<boolean>(kn, v, new CheckboxHTMLRenderer(), { 
                        onSet: (val: boolean) => {
                            (keys as any)[kn] = val;
                            this.keysSettings.change(keys);
                        }})];
                } else if (isHourMin(v)) {
                    ret = [
                        newWritableProperty<HourMin>(kn, v, 
                            new HourMinHTMLRenderer(), 
                            {
                                onSet: (val: HourMin) => {
                                    (keys as any)[kn] = val;
                                    this.keysSettings.change(keys);
                                }
                            })
                    ];
                } else if (isSoundAction(v)) {
                    ret = [
                        newWritableProperty<number>(kn, v.index, 
                            new SelectHTMLRenderer<number>(Array.from(ClockController.mp3Names.keys()), 
                                v => {
                                    const item = ClockController.mp3Names.get(v);
                                    if (item) {
                                        return v + '. ' + item[0] + ' (' + toFixedPoint(item[1], 1) + 'с)'
                                    } else {
                                        return "";
                                    }
                                }), 
                            {
                                onSet: (val: number) => {
                                    v.index = val;
                                    this.keysSettings.change(keys);
                                }
                            }),
                        newWritableProperty("Volume", v.volume,
                            new SliderHTMLRenderer(), 
                            {
                                onSet: (val: number) => {
                                    v.volume = val;
                                    this.keysSettings.change(keys);
                                }
                            })
                    ];
                } else {
                    this.log("Property " + kn + " has unsupported type" + typeof(v));
                    return [] as Property<any>[];
                }
   
                return ret as Property<any>[];
            });
        }],
        ['log', async () => {
            return [
                [this.clearGlobalLog], 
                [this.globalLog]
            ];
        }],
        ['actions', async () => {
            // const actions = await this.actions.read();
            return [];
        }]
    ]);

    private reloadAllWebClients(val: WebPageType) {
        this.broadcastToWebClients({ type: "reloadProps", value: val });
    }


    private get controllers(): Controller[] {
        const dynPropsArray = Array.from(this.dynamicControllers.values());
        dynPropsArray.sort((a, b) => a.name.localeCompare(b.name));

        return Array.prototype.concat([
                this.sleepAt.controller,
                this.wakeAt.controller,
                this.timer.controller,
                this.ctrlControlOther,
                this.ctrlPullups,
                this.ctrlWeather,
                this.miLight,
            ],
            GPIORelay.gpioInstalled() ? [ this.ctrlGPIO ] : [],
            this.allOnlineTablets(),
            dynPropsArray,
            this.renderChannels()
        );
    }

    private simpleCmd(prefixes: string[][], showName: string, action: (from: RemoteEnd, keys: string[]) => void): IRKeysHandler {
        return {
            partial: (remoteId, arr, finalCheck) => {
                if (prefixes.some(prefix => arraysAreEqual(prefix, arr))) {
                    return 0; // Accept immediatelly
                }

                if (prefixes.some(prefix => arraysAreEqual(prefix.slice(0, arr.length), arr))) {
                    return 1500; // Wait for cmd to complete
                }
                return null;
            },
            complete: (from, arr) => {
                this.allInformers.runningLine(showName, 2000);
                this.log('Performing action ' + showName + " initialized by " + from.remoteId + " [" + arr.join(',') + "]");
                action(from, arr);
            }
        } as IRKeysHandler;
    }

    private createPowerOnOffTimerKeys(prefix: string, actions: () => { showName: string, valueName?: string, action: (dd: number) => void }[]): IRKeysHandler {
        return {
            partial: (remoteId, arr, finalCheck) => {
                const firstNonPref = getFirstNonPrefixIndex(arr, prefix)
                if (firstNonPref == 0 || arr.slice(firstNonPref).some(x => !isNumKey(x))) {
                    return null; // Not our beast
                }

                const actionsa = actions();
                const a = actionsa[(firstNonPref - 1) % actionsa.length];
                if (firstNonPref == arr.length) {
                    // No numbers yet
                    this.allInformers.runningLine(a.showName, 2000);
                    return 3000;
                } else {
                    // Numbers are here
                    this.allInformers.staticLine(numArrToVal(arr.slice(firstNonPref)) + (a.valueName || ""));
                    return 2000;
                }
            },
            complete: (remoteId, arr) => {
                const firstNonPref = getFirstNonPrefixIndex(arr, prefix)
                const dd = numArrToVal(arr.slice(firstNonPref));
                if (dd) {
                    const actionsa = actions();
                    actionsa[(firstNonPref - 1) % actionsa.length].action(dd);
                }
            }
        };
    }

    private timerIn(
            val: number,
            name: string,
            timer: { val: HourMin, fireInSeconds: (sec: number) => void}): void {
        timer.fireInSeconds(val);
        delay(3000).then(() => 
            this.allInformers.runningLine(name + " в " + timer.val.h + ":" + timer.val.m.toLocaleString('en', { minimumIntegerDigits:2 }), 3000) );
    }

    private makeSwitchChannelIrSeq(irk: string) {
        return this.createPowerOnOffTimerKeys(irk, () => 
            this.allOnlineTablets().map(t => ({
                showName: t.shortName, 
                action: (dd: number) => {
                    const chan = this.channelsHistoryConf.last().channels.find(c => c.channel == dd);
                    if (chan) {
                        t.stopPlaying()
                            .then(() => {
                                this.playURL(t, chan.url, chan.name);
                            });
                    } else {
                        this.allInformers.runningLine("Канал " + dd + " не найден", 3000);
                    }
                }
            })).slice());
    }

    private makeUpDownKeys(keys: {keys: string[], remoteId?: string, action: (from: RemoteEnd, key: string) => void}[], delay: number = 2500): IRKeysHandler {
        return {
            partial: (from, arr, final) => {
                const allAreVolControls = arr.length > 0 && arr.every(k => keys.some(kk => kk.keys.indexOf(k) !== -1));
                if (allAreVolControls) {
                    if (!final) {
                        const last = arr[arr.length - 1];
                        const kk2 = keys.find(kk => 
                            (kk.keys.indexOf(last) !== -1) && 
                            (!kk.remoteId || kk.remoteId == from.remoteId));
                        if (kk2) {
                            kk2.action(from, last)
                        }
                    }

                    return delay;
                } else {
                    return null; // We didn't recognize the command
                }

            },
            complete: (remoteId, arr) => {
                // console.log("Nothing to do");
            }
        } as IRKeysHandler;
    }

    private dayBeginsTimer: Disposable = emptyDisposable;
    private dayEndsTimer: Disposable = emptyDisposable;

    private dayBegins() {
        this.isSleeping = false;
        const clock = this.findDynController('ClockNRemote');
        if (clock) {
            clock.screenEnabledProperty.set(true);
        }
    }

    private async switchLightOnWaitAndOff() {
        this.miLight.switchOn.set(true);
        await delay(300);
        this.miLight.brightness.set(70);
        await delay(300);
        this.miLight.allWhite.set(true);
        await delay(3*60*60*1000); // In 3 hours, switch the light off
        this.miLight.switchOn.set(false);
        this.log('Switch light off');    
    }

    private dayEnds() {
        const clock = this.findDynController('ClockNRemote');
        if (clock) {
            if (clock.lcdInformer) {
                clock.lcdInformer.runningLine("Закат", 3000);
            }
        }

        (async () => {
            const keys = await this.keysSettings.read();
            if (keys.simulateHostAtHome) {
                // await delay(Math.random()*30*60*1000); // Wait [0..30] minutes
                this.log('Switch light on');
                await this.switchLightOnWaitAndOff();
            }
        })();
    }

    private modifyBrightnessMi(delta: number): number {
        const brNow = this.miLight.brightness.get() + delta;
        this.miLight.brightness.set(brNow);
        return this.miLight.brightness.get();
    }

    private lights(): OnOff[] {
        const dynSwitchers = ['RoomSwitchers', 'RelayOnKitchen', 'NoncontactSwitch']
                    .map(name => {
                        const dc = this.findDynController(name);
                        return (dc ? dc.relays : []) as OnOff[];
                    });

        const ledStripe = this.findDynController('LedStripe');
        const app = this;
        
        return ([
                this.miLight.switchOn,
                this.r1,
                // this.r3,
                this.r4,
            ] as OnOff[])
            .concat(...dynSwitchers)
            .concat(...(ledStripe ? [ 
                new (class R extends Relay {
                    public get(): boolean {
                        return ledStripe.ledStripeColorProperty.get() !== '00000000';
                    }
                    public switch(on: boolean): Promise<void> {
                        app.log('Switching off ', true);
                        ledStripe.ledStripeColorProperty.set(on ? '000000FF' : '00000000');
                        return Promise.resolve(void 0);
                    }
                })('Лента на двери', 'Комната')] : []))
            .concat(...(([
                    ['LedController1', 'Коридор', 'Коридор'], 
                    // ['SmallLamp', 'Маленькая лампа на столе', 'Комната']
                    ['RoomLedController', 'Ленты на карнизах', 'Комната'], 
                ])
                .filter(([id]) => {
                    return this.findDynController(id);
                })
                .map(([id, name, location]) => {
                    const ledController1 = this.findDynController(id);
                    return new (class R extends Relay {
                        public get(): boolean {
                            return ledController1!.screenEnabledProperty.get();
                        }
                        public switch(on: boolean): Promise<void> {
                            ledController1!.screenEnabledProperty.set(on);
                            return Promise.resolve(void 0);
                        }
                    })(name, location)
                }))
            .filter(v => v.name));
    }

    private savedVolumeForMute?: number;

    private irKeyHandlers: IRKeysHandler[] = [
        this.createPowerOnOffTimerKeys('power', () => [
            { showName: "Выключение", valueName: "мин", action: (dd) => this.timerIn(dd * 60, "Выключение", this.sleepAt) },
            { showName: "Включение", valueName: "мин", action: (dd) => this.timerIn(dd * 60, "Включение", this.wakeAt) },
            { showName: "Таймер", valueName: "мин", action: (dd) => this.timerIn(dd * 60, "Таймер", this.timer) }
        ]),
        this.makeSwitchChannelIrSeq('ent'),
        this.makeSwitchChannelIrSeq('reset'),
        this.simpleCmd([['fullscreen']], "", () => {
            const ledStripe = this.findDynController('LedStripe');
            if (ledStripe) {
                ledStripe.send({ type: 'ledstripe', 
                    newyear: true, 
                    basecolor: "00080000", 
                    blinkcolors: Array.prototype.concat(
                        Array(2).fill("0000FF00"),
                        Array(3).fill("00008000"),
                        // Array(2).fill("00FFFF00"),
                        Array(2).fill("FFFF0000"),
                        Array(2).fill("FF00FF00"),
                        Array(3).fill("FF000000"))
                            .join(''), 
                    period: 8000 });
            }
        }),
        this.simpleCmd([["record"]], "Лента на шкафу", (from) => {
            this.sound(from.controller, this.r1.get() ? 'lightOff' : 'lightOn');
            this.r1.switch(!this.r1.get());
        }),
        this.simpleCmd([['stop']], "Ленты на карнизах", (from) => {
            const l = this.lights();
            const onoff = l.find(x => x.name === 'Ленты на карнизах');
            if (onoff) {
                this.sound(from.controller, onoff.get() ? 'lightOff' : 'lightOn');
                onoff.switch(!onoff.get());
            }
        }),
        this.simpleCmd([['time_shift']], "Потолок в комнате", (from) => {
            const roomSwitch = this.findDynController('RoomSwitchers');
            if (roomSwitch) {
                this.sound(from.controller, roomSwitch.relays[2].get() ? 'lightOff' : 'lightOn');
                roomSwitch.relays[2].switch(!roomSwitch.relays[2].get());
            }
        }),
        this.simpleCmd([['av_source']], "Лента на двери", (from) => {
            const ledStripe = this.findDynController('LedStripe');
            if (ledStripe) {
                const prop = ledStripe.ledStripeColorProperty;
                this.sound(from.controller, prop.get() === '00000000' ? 'lightOn' : 'lightOff');
                prop.set(prop.get() === '00000000' ? '000000FF' : '00000000');
            }
        }),
        this.simpleCmd([['clear'], ['recall']], "MiLight", (from) => {
            this.sound(from.controller, this.miLight.switchOn.get() ? 'lightOff' : 'lightOn');
            this.miLight.switchOn.switch(!this.miLight.switchOn.get());
        }),

        this.simpleCmd([['mts']], "Потолок на кухне", (from) => {
            this.toggleRelay(from.controller, 'RelayOnKitchen', 0);
        }),
        this.simpleCmd([['min']], "Лента на кухне", (from) => {
            this.toggleRelay(from.controller, 'RelayOnKitchen', 1);
        }),
        this.simpleCmd([['mute']], "Тихо", () => {
            if (this.savedVolumeForMute === undefined) {
                this.allInformers.staticLine('Тихо');
                this.savedVolumeForMute = this.kindle.volume.get();
                this.kindle.volume.set(0);
            } else {
                this.allInformers.staticLine('Громко');
                this.kindle.volume.set(this.savedVolumeForMute);
                this.savedVolumeForMute = undefined;
            }
        }),
        // Sound controls
        this.makeUpDownKeys([
            { keys: ['volume_up', 'volume_down'], action: (remote, key) => { 
                let tablet = this.kindle;
                if (remote.remoteId === 'tvtuner') {
                    tablet = this.nexus7TCP;
                }
                if (!tablet.screenIsOn.get()) {
                    tablet.screenIsOn.set(true);
                }
                tablet.volume.set(tablet.volume.get() + (key === 'volume_up' ? +1 : -1) * 100 / 30)
            }}
        ]),
        this.simpleCmd([['click']], "MiLight", (from, keys) => {
            const clock = this.findDynController('ClockNRemote');

            if (from.remoteId == 'encoder_middle') {
                const onNow = this.miLight.switchOn.get();
                this.miLight.switchOn.switch(!onNow);

                const ledController1 = this.findDynController('LedController1');
                if (ledController1) {
                    ledController1.screenEnabledProperty.set(!onNow);
                }
        
                if (clock) {
                    this.sound(clock, onNow ? 'lightOff' : 'lightOn');
                }
            } else if (from.remoteId == 'encoder_left') {
                const roomSwitch = this.findDynController('RoomSwitchers');
                if (roomSwitch) {
                    let onNow = false;
                    const each = (fn: (r: Relay) => void) => {
                        for (const i of [0, 1]) {
                            const relay = roomSwitch.relays[i];
                            fn(relay);
                        }
                    };
                    each(r => onNow = onNow || r.get());
                    each(r => r.set(!onNow));

                    if (clock) {
                        this.sound(clock, onNow ? 'lightOff' : 'lightOn');
                    }
                }
            }
        }),
        this.makeUpDownKeys([
            { keys: ['rotate_cw', 'rotate_ccw'], action: (from, key) => {
                const sign = (key === 'rotate_cw' ? +1 : -1);
                if (from.remoteId === 'encoder_left') {
                    if (!this.kindle.screenIsOn.get()) {
                        this.kindle.screenIsOn.set(true);
                    }
                    this.kindle.volume.set(this.kindle.volume.get() + sign * 100 / 30);
                } else if (from.remoteId === 'encoder_middle') {
                    const nowBr = this.modifyBrightnessMi(sign * 10);
                    const ledController1 = this.findDynController('LedController1');
                    if (ledController1) {
                        ledController1.d4PWM!.set(nowBr);
                    }            
                }
            }}
        ], 10),
        new (class LightMenu implements IRKeysHandler {
            constructor(private _app: App) {
            }

            public partial(from: RemoteEnd, arr: string[], final: boolean, timestamps: number[]): number | null {
                if (from.remoteId === 'encoder_right') {
                    if (arr.length == 0) {
                        return null;
                    }

                    if (arr.length == 1 && arr[arr.length - 1] === 'click') {
                        return null; // single click is probably jitter, let's ignore
                    }

                    if (arr.length >= 2 && arr[arr.length - 1] === 'click') {
                        return 200; // we've done with menu
                    }

                    const val = this.getCurrent(arr, timestamps);

                    this._app.allInformers.runningLine(val.name, 2000);

                    return 3000;
                }

                return null;
            }

            private getCurrent(arr: string[], timestamps: number[]) {
                const ind: number = arr.reduce((prevVal: number, val, index) => {
                    if (index > 0 && (timestamps[index] - timestamps[index - 1]) < 20) {
                        return prevVal; // JITTER
                    }

                    if (val === 'rotate_cw') {
                        return prevVal + 1;
                    }
                    else if (val === 'rotate_ccw') {
                        return prevVal - 1;
                    }
                    return prevVal; // just ignore
                }, 0);
                const ll = this._app.lights();
                const val = ll[((ind % ll.length) + ll.length) % ll.length];
                return val;
            }

            public complete(from: RemoteEnd, arr: string[], timestamps: number[]): void {
                if (arr.length >= 2 && arr[arr.length - 1] === 'click') {
                    const val = this.getCurrent(arr, timestamps);
                    val.switch(!val.get());   
                    this._app.allInformers.runningLine('Нажат ' + val.name, 3000);
                    this._app.sound(from.controller, val.get() ? 'lightOff' : 'lightOn');
                }
            }
        })(this),
        this.makeMainMenu(menuKeys, {
            lbl: '', submenu: () => [
                { lbl: 'Свет', submenu: () =>
                    this.lights().map(x => ({
                            lbl: x.name,
                            action: (from) => {
                                x.switch(!x.get());
                                this.sound(from.controller, x.get() ? 'lightOff' : 'lightOn');
                            }
                        }))
                },
                {
                    lbl: 'Каналы', 
                    submenu: () => this.channelsHistoryConf.last().channels.map((c, i) => ({
                        lbl: c.name,
                        submenu: () => Array.prototype.concat(
                            this.allOnlineTablets().map(t => ({
                                lbl: "на " + t.shortName,
                                action: () => {
                                    this.playChannel(t, c);
                                }
                            }))
                            ,[])
                    }) as Menu)
                },
                {
                    lbl: 'Планшеты', 
                    submenu: () => this.allOnlineTablets().map(t => ({
                        lbl: t.shortName,
                        submenu: () => [
                            { lbl: 'Вкл', action: async () => {
                                await t.screenIsOn.set(true);
                            }},
                            { lbl: 'Выкл', action: async () => {
                                await t.stopPlaying(); 
                                await t.screenIsOn.set(false);
                            }},
                            { lbl: 'Reboot', action: () => this.log('REBOOT') }
                        ]
                    } as Menu))
                }
        ]} as Menu)
    ];

    private makeMainMenu(menuKeys: MenuKeysType, menu: Menu): IRKeysHandler {
        return {
            partial: (from, arr, final) => {
                const keyset = menuKeys[from.remoteId];
                // console.log(arr.slice(0, 1), [ keyset.menu ]);
                if (!!keyset && arraysAreEqual(arr.slice(0, 1), [keyset.menu])) {
                    const ind = [0];
                    arr.slice(1).forEach(val => {
                        switch (val) {
                            case keyset.up:
                                ind[ind.length - 1]--;
                                break;
                            case keyset.down:
                                ind[ind.length - 1]++;
                                break;
                            case keyset.menu:
                                ind.splice(0, ind.length);
                                ind.push(0);
                                break;
                            case keyset.left:
                                ind.pop();
                                break;
                            case keyset.right:
                                ind.push(0);
                                break;
                        }
                    });
                    type Aux = [Menu, boolean, number];
                    const res: Aux = ind.reduce((dd: Aux, i) => {
                        if ('submenu' in dd[0]) {
                            const arrr = dd[0].submenu();
                            for (; i < 0; i += arrr.length);
                            i = i % arrr.length;
                            return [ arrr[i], false, i] as Aux;
                        }
                        else {
                            return [ dd[0], true, 0] as Aux;
                        }
                    }, [ menu, false, 0]);
                    if (res) {
                        if (('action' in res[0]) && res[1]) {
                            if (final) {
                                res[0].action(from); // Go ahead!
                            } else {
                                return 0;
                            }
                        }
                        const line = res[0].lbl;
                        from.controller.lcdInformer?.runningLine(line, 8000);
                    }
                    return 8000;
                }
                return null; // We didn't recognize the command
            },
            complete: (remoteId, arr) => {}
        } as IRKeysHandler;
    }

    public nextChannel(tbl: Tablet, add: number): Channel {
        const inArr = this.channelsHistoryConf.last().channels.filter(c => !!c.channel).slice();

        if (inArr.length == 0) {
            // Means there is not set channels yet
            return { name: "", url: ""} as Channel;
        }

        const lastChannel = inArr[0];

        inArr.sort((a1, a2) => a1.channel === a2.channel ? 0 : 
            (((a1.channel || -1) < (a2.channel || -1) ? -1 : 1)));
        
        
        const prevIndex = inArr.findIndex(c => c === lastChannel);
        const newIndex = prevIndex + add;

        return inArr[(newIndex + inArr.length) % inArr.length];
    }

    private readonly mapIRs = new Map<string, {
        lastRemote: number,
        seq: string[],
        handler?: IRKeysHandler,
        wait: number,
        timestamps: number[]
    }>();

    private onIRKey(remoteId: string, keyId: string, clockController: ClockController) {                                  
        var _irState;
        if (!this.mapIRs.has(remoteId)) {
            _irState = { lastRemote: 0, seq: [], wait: 1500, timestamps: [] };
            this.mapIRs.set(remoteId, _irState);
        } else {
            _irState = this.mapIRs.get(remoteId);
        }

        const irState = _irState!;
        const now = new Date().getTime();
        const remoteEnd = { remoteId, controller: clockController };

        irState.seq.push(keyId);
        irState.timestamps.push(now);
        var toHandle;
        for (const handler of this.irKeyHandlers) {
            const toWait = handler.partial(remoteEnd, irState.seq, false, irState.timestamps);
            if (toWait != null) {
                toHandle = handler;
                irState.wait = toWait;
            }
        }
        if (toHandle) {
            irState.handler = toHandle;
        } else {
            this.log('Ignored ' + irState.seq.join(",") + ' on ' + remoteId);
            irState.seq = [];
        }

        delay(irState.wait).then(() => {
            const now = new Date().getTime();
            if ((now - irState.lastRemote) >= irState.wait) {
                // Go!
                if (irState.handler && irState.handler.partial(remoteEnd, irState.seq, true, irState.timestamps) !== null) {
                    irState.handler.complete(remoteEnd, irState.seq, irState.timestamps);
                }

                irState.seq = [];
                irState.lastRemote = now;
            }
        });

        irState.lastRemote = now;
    }

    public toggleRelay(remote: ClockController, relayName: string, index: number): void {
        const kitchenRelay = this.findDynController(relayName);
        if (kitchenRelay) {
            this.sound(remote, kitchenRelay.relays[index].get() ? 'lightOff' : 'lightOn');
    
            kitchenRelay.relays[index].switch(!kitchenRelay.relays[index].get());
        }
    }

    private destinies: number[] = [];
    private ignoreDestinies = false;

    private async onHCSR(clockController: ClockController, on: boolean) {
        // console.log("onHCSR", clockController.internalName, ">>", on);

        if (!on) {
            if (clockController.internalName === 'PullupCounter') {
                this.pullups.set(this.pullups.get() + 1);

                const res = await curl.get("http://192.168.121.38:81/pullup/")
                const cr = this.findDynController('ClockNRemote');
                if (cr && cr.lcdInformer) {
                    cr.lcdInformer.staticLine(res);
                    this.sound(cr, 'pullUp');
                }

                console.log("PULLUP " + res);
            }
        }
    }



    private async onRawDestinies(clockController: ClockController, timeSeq: number, destinies_: number[]) {
        // console.log(clockController.internalName)
        if (clockController.internalName == 'PullupCounter') {
        } else if (clockController.internalName == 'NoncontactSwitch') {
            // console.log("[" + destinies_.join(",") + "]")
            if (!this.ignoreDestinies) {
                if (destinies_.reduce((prev, now) => (now < 1500 ? prev+1 : prev), 0) > 4) {
                    {
                        console.log('Non-contact switch')
                        const stateThis = clockController.relays[0].get();
                        const cntrlrs  = [
                            [ clockController, [0]], [this.findDynController('RoomSwitchers'), [0, 1]]
                        ].filter ( x => !!x ) as [ClockController, number[]][]
        
                        const swtch = (swon: boolean) => cntrlrs.forEach( c => c[1].forEach(rI => c[0].relays[rI].switch(swon)));
        
                        swtch(!stateThis);        
                    }
                    this.ignoreDestinies = true;
                    await delay(1000);
                    this.ignoreDestinies = false;
                }
            }
        }
    }

    private async onRawIRKey(clockController: ClockController, timeSeq: number, periods_: number[]) {
        // First, remove noise
        let periods = periods_.reduce((per, v, i) => {
            if (v > 50 && v < 100000) {
                per.push(v);
            }
            return per;
        }, [] as number[]);

        // pre-process periods - find 4400 ns (which is startup seq)
        for (let i = 0; i < periods.length; ++i) {
            if (periods[i] > 4100 && periods[i] < 4700) {
                periods = periods.slice(i);
                break;
            }
        }

        if (periods.length < 20) {
            this.log('Got some noise from IR: ' + periods_.map(x => x.toString()).join(', '));
            return;
        }

        this.lastPressedIrKey.set(periods);
        const k = await this.recognizeIRKey(periods);
        this.lastPressedIrKeyRecognizedAs.set(k.remoteName + ":" + k.keyName);
        this.lastPressedKey.set("");
        this.lastPressedRemote.set("");
        if (!!k.keyName || !!k.remoteName) {
            this.onIRKey(k.remoteName, k.keyName, clockController);
            this.log("Recognized " + k.remoteName + " " + k.keyName + " from " + clockController.ip);
        }
        this.reloadAllWebClients('ir');        
    }

    private async updateWeather() {
        const cityid = 693805;
        const keys = await this.keysSettings.read();
        const ress = await curl.get(`https://api.openweathermap.org/data/2.5/weather?id=${cityid}&mode=json&units=metric&lang=ru&APPID=${keys.weatherApiKey}`);
        const jso = JSON.parse(ress) as (WeatherInfo | WeatherError400 | WeatherError500);
        if (jso.cod === 200) {
            //jso
            // console.log(jso.weather[0]);
            const str = jso.weather[0].description + ' ' + tempAsString(jso.main.temp) + ' ветер ' + jso.wind.speed + 'м/c';
            this.log(str);
            this.nowWeather.set(str);
            this.nowWeatherIcon.set(`http://openweathermap.org/img/w/${jso.weather[0].icon}.png`);
        } else {
            this.log(ress);
        }
    }

    constructor() {
        this.updateWeather();
        // Each 15 mins, update weather
        setInterval(() => this.updateWeather(), 15*60*1000);

        setInterval(() => {
            this.tablets.forEach((t: Tablet) => {
                if (!t.online && t.isTcp) {
                    const oldOnline = t.online;
                    t.connectIfNeeded()
                        .then(() => {
                            if (oldOnline != t.online) {
                                this.reloadAllWebClients('web');
                            }
                        })
                        .catch(e => {});
                }
            });
        }, 3*1000);
        /*
        const sock = dgram.createSocket("udp4");
        let oldClr = 0;

        setInterval(async () => {
            let clr = 0;
            while (clr == oldClr) clr = Math.random() * 0x8;

            let w = 160;
            let h = 16;
            for (let nn = 0; nn < 3; ++nn) {
                for (let x = 0; x < 320; x+=w) {
                    for (let y = 0; y < 240; y+=h) {
                        sock.send(
                            Buffer.concat([
                                new Buffer([0, x/256, x%256, y/256, y%256, w, h]),
                                new Buffer(w*h/2).fill(clr | clr << 4)
                            ]),
                            49152, "192.168.121.170", (err, bytes) => {
                            // this.log(err, bytes);
                        });
                        await delay(0);
                    }
                }
                await delay(10);
            }
        }, 3000);
        */
        
        this.channelsHistoryConf.read();        

        // Load TV channels from different m3u lists

        this.tvChannels.read().then(conf => {
            if ((new Date().getTime() - conf.lastUpdate) / 1000 > 10*60) {
                this.reloadM3uPlaylists();
            }
            this.log("Read " + conf.channels.length + " M3U channels");
        });

        const getSunrizeSunset = () => {
            const now = new Date();
            this.log('sunrise query');
            curl.get(`https://api.sunrise-sunset.org/json?formatted=0&lat=${this.lat}&lng=${this.lng}&date=${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`)
                .then(async resStr => {
                    const res = JSON.parse(resStr) as SunrizeError | SunrizeDate;
                    if (res.status === 'OK') {
                        let twilightBegin = new Date(res.results.civil_twilight_begin);
                        const dba = (await this.keysSettings.read()).dayBeginsAt;
                        const at7_00 = new Date(twilightBegin.getFullYear(), twilightBegin.getMonth(), twilightBegin.getDate(), dba.h, dba.m, dba.s || 0, 0);
                        if (twilightBegin.getTime() > at7_00.getTime()) {
                            // If it's too dark at 7:00 - switch screen on anyway
                            twilightBegin = at7_00;
                        }
                        const twilightEnd = new Date(res.results.civil_twilight_end)

                        this.log('sunrise is at ' + twilightBegin.toLocaleString());
                        this.dayBeginsTimer.dispose();
                        this.dayBeginsTimer = doAt(twilightBegin.getHours(), twilightBegin.getMinutes(), twilightBegin.getSeconds(), () => { this.dayBegins() });

                        this.log('sunset is at ' + twilightEnd.toLocaleString());
                        this.dayEndsTimer.dispose();
                        this.dayEndsTimer = doAt(twilightEnd.getHours(), twilightEnd.getMinutes(), twilightEnd.getSeconds(), () => { this.dayEnds() });
                    }
                })
        };

        doAt(0, 5, 0, getSunrizeSunset);
        getSunrizeSunset();

        // Each hour reload our playlists
        setInterval(() => {
            this.reloadM3uPlaylists();
        }, 1000*60*60);

        const udpServer = dgram.createSocket("udp4");
        setInterval(() => {
            for (const controller of this.dynamicControllers.values()) {
                if (!controller.wasRecentlyContacted()) {
                    // console.log(this.name, this.ip, "wasRecentlyContacted returned false", this.lastResponse, Date.now());
                    // 6 seconds passed, no repsonse. Drop the connection and re-try
                    controller.dropConnection();
                }
            }
        }, 1000);

        const sendUdpMsg = (address: string, modify: (m: MsgBack) => void) => {
            const back = new MsgBack();
            back.setId(42);                   
            modify(back);

            const buf = back.serializeBinary();
            // console.log(buf.toString());

            // send
            udpServer.send(buf, UDP_SERVER_PORT, address, (err, bytes) => {
                if (err) {
                    this.log(err.toString());
                }
            });
        }

        udpServer.on('error', err => {
            console.error(err);
            udpServer.close();
        });
        const lastHelloReqSent: Map<string, number> = new Map();
        udpServer.on('message', (msg, rinfo) => {
            const controller = this.dynamicControllers.get(rinfo.address);

            try {
                const newLocal = Msg.deserializeBinary(msg);
                const typedMessage = newLocal.toObject();

                if (controller) {
                    // this.log(rinfo.address, controller.lastResponse, Date.now());
                    controller.lastResponse = Date.now();
                    controller.lastMsgLocal = typedMessage.timeseq!;
                } else {
                    this.log('Message from controller that is not initialized:' + rinfo.address + "  " + JSON.stringify(typedMessage));
                }

                if (typeof(typedMessage.buttonpressedd2) != 'undefined') {
                    console.log("D2", typedMessage.buttonpressedd2);
                }
                if (typeof(typedMessage.buttonpressedd5) != 'undefined') {
                    console.log("D5", typedMessage.buttonpressedd5);
                }
                if (typeof(typedMessage.buttonpressedd7) != 'undefined') {
                    console.log("D7", typedMessage.buttonpressedd7);
                }
                if (typeof(typedMessage.hcsron) != 'undefined') {
                    if (controller) {
                        this.onHCSR(controller, typedMessage.hcsron);
                    }
                }
                if (typedMessage.potentiometer) {
                    if (controller) {
                        this.onPotentiometer(controller, typedMessage.potentiometer);
                    }
                }
                if (typedMessage.debuglogmessage) {
                    this.log(rinfo.address + " " + typedMessage.debuglogmessage);
                }
                if (typedMessage.relaystatesList && typedMessage.relaystatesList.length > 0) {
                    if (controller) {
                        for (const r of typedMessage.relaystatesList) {
                            controller.setRelayState(r.id!, r.state!);
                        }
                    }
                }
                if (typeof (typedMessage.atxstate) !== 'undefined') {
                    this.log("ATX: " + typedMessage.atxstate);
                }
                if (typedMessage.hello) {
                    if (controller && controller.lastMsgLocal && (controller.lastMsgLocal! > typedMessage.timeseq!)) {
                        this.log('Controller was restarted ' + rinfo.address);
                        controller.dropConnection();
                    }
                    this.createClockController({
                        type: 'hello',
                        firmware: typedMessage.hello.versionmajor + "." + typedMessage.hello.versionminor,
                        afterRestart: 0,
                        screenEnabled: typedMessage.hello.screenenabled,
                        devParams: JSON.parse(typedMessage.hello.settings || "{}")
                    }, rinfo.address, {
                        send: (packet: AnyMessageToSend) => {
                            sendUdpMsg(rinfo.address, (m: MsgBack) => {
                                // TODO: Impl
                                switch (packet.type) {
                                    case 'reboot':
                                        m.setReboot(true);
                                        break;
                                    case 'show':
                                    case 'tune':
                                    case 'additional-info':
                                        if (packet.totalMsToShow) {
                                            m.setTimemstoshow(packet.totalMsToShow);
                                        }
                                        m.setTexttoshow(packet.text);
                                        m.setShowtype({
                                            'show': MsgBack.ShowType.SHOW,
                                            'tune': MsgBack.ShowType.TUNE,
                                            'additional-info': MsgBack.ShowType.ADDITIONAL
                                        }[packet.type]);
                                        break;
                                    case 'switch':
                                        // this.log('Switching ' + rinfo.address + " " + packet.id + ' to ' + packet.on, true);
                                        m.setRelaystoswitch(+packet.id);
                                        m.setRelaystoswitchstate(packet.on === 'true');
                                        break;
                                    case 'atxEnable':
                                        m.setAtxenable(packet.value);
                                        break;
                                    case 'playmp3':
                                        m.setPlaymp3(+packet.index);
                                        break;
                                    case 'setvolume':
                                        m.setVolume(+packet.value);
                                        break;
                                    case 'screenEnable':
                                        m.setScreenenable(packet.value);
                                        break;
                                    case 'brightness':
                                        m.setBrightness(packet.value);
                                        break;
                                    case 'pwm':
                                        m.setPwmpin(+(packet.pin.slice(1)));
                                        m.setPwmvalue(packet.value);
                                        m.setPwmperiod(packet.period);
                                        break;
                                    case 'ledstripe':
                                        m.setLedperiod(packet.period);
                                        if ('newyear' in packet) {
                                            m.setLedbasecolor(packet.basecolor);
                                            m.setLedblinkcolors(packet.blinkcolors);
                                        } else {
                                            m.setLedvalue(packet.value);
                                        }
                                        break;
                                    case 'unixtime':
                                        m.setUnixtime(Math.floor((new Date()).getTime() / 1000));
                                        break;
                                    case 'ping':
                                        break;
                                    case 'screen':
                                        const offsetsArr = packet.offsets.map(
                                            x => {
                                                const so = new ScreenOffset();
                                                so.setX(x.x);
                                                so.setY(x.y);
                                                so.setAtms(x.at);
                                                return so;
                                            }
                                        );
                                        m.setScreenoffsetfrom(offsetsArr[0]);
                                        m.setScreenoffsetto(offsetsArr[1]);
                                        const sc = new ScreenContent();
                                        sc.setWidth(packet.content.width);
                                        sc.setHeight(packet.content.height);
                                        sc.setContent(packet.content.content);
                                        m.setScreencontent(sc);
                                }
                            });
                        },
                        disconnect: () => {
                            // Something to do?
                        }
                    });
                    // Reload
                    this.reloadAllWebClients('web');
                } else {
                    if (!controller && 
                        (!lastHelloReqSent.has(rinfo.address) ||
                        (Date.now() - lastHelloReqSent.get(rinfo.address)! > 3000))) {
                        // Let other side introduce self
                        sendUdpMsg(rinfo.address, (m: MsgBack) => {
                            m.setIntroduceyourself(true);
                        })
                        lastHelloReqSent.set(rinfo.address, Date.now());
                    }
                }
                if (typedMessage.irkeyperiodsList && typedMessage.irkeyperiodsList.length > 0) {
                    // this.log(typedMessage.irkeyperiodsList.join(','));
                    if (controller) {
                        this.onRawIRKey(controller, typedMessage.timeseq!, typedMessage.irkeyperiodsList);
                    }
                }
                if (typedMessage.destiniesList && typedMessage.destiniesList.length > 0) {
                    if (controller) {
                        this.onRawDestinies(controller, typedMessage.timeseq!, typedMessage.destiniesList);
                    }
                }
                if (typedMessage.parsedremote) {
                    if (controller) {
                        this.onIRKey(typedMessage.parsedremote.remote!, typedMessage.parsedremote.key!, controller);
                    }
                }

                if (typedMessage.humidity && typedMessage.temp && typedMessage.pressure) {
                    if (controller) {
                        controller.tempProperty.setInternal(typedMessage.temp);
                        controller.humidityProperty.setInternal(typedMessage.humidity);
                        controller.pressureProperty.setInternal(typedMessage.pressure);
                    }
    
                    this.weatherChanged(typedMessage.temp, typedMessage.pressure, typedMessage.humidity);
                }
                // console.log(JSON.stringify(typedMessage, undefined, ' '));
            } catch (e) {
                this.log(e.toString());
            }
            // console.log(`server got: ${msg} from ${rinfo.address}:${rinfo.port}`);
        });
        udpServer.on('listening', () => {
            const address = udpServer.address();
            this.log(`server listening ${address.address}:${address.port}`);
        });
        udpServer.bind(UDP_SERVER_PORT);

        this.expressApi = express();

        this.server = http.createServer(this.expressApi);

        this.wss = new WebSocket.Server({ server: this.server });
        this.wss.on('connection', (ws: WebSocket, request) => {
            const url = (request.url || '/').split('/').filter(p => !!p);
            // console.log("Connection from", request.connection.remoteAddress, request.url);
            const remoteAddress = request.connection.remoteAddress!;
            const ip = request.connection.remoteFamily + "_" + parseOr(remoteAddress, /::ffff:(.*)/, remoteAddress) + ":" + request.connection.remotePort;
            ws.url = url[0];

            //connection is up, let's add a simple simple event
            if (arraysAreEqual(url, ['esp'])) {
                ws.on('close', (data: string) => {
                    const controller = this.dynamicControllers.get(ip);
                    this.log(((controller || {name: ip}).name) +  "CLOSE");
                });
                // This is ESP controller!
                ws.on('message', (data: string) => {
                    try {
                        const objData = JSON.parse(data);
                        const controller = this.dynamicControllers.get(ip);

                        // It might be hello message
                        if ('type' in objData && objData.type == 'hello') {
                            let clockController = this.createClockController(objData, ip, {
                                send: (json: AnyMessageToSend) => {
                                    const txt = JSON.stringify(json);
                                    ws.send(txt);
                                },
                                disconnect: () => {
                                    if (ws.readyState === ws.OPEN) {
                                        // console.log(this.ip, "CLOSE");
                                        ws.close();
                                    }                            
                                }
                            });
                            // Reload
                            this.reloadAllWebClients('web');

                            ws.on('error', () => { clockController.dropConnection(); });
                            ws.on('close', () => { clockController.dropConnection(); });
                        } else if (controller) {
                            controller.processMsg(objData);
                        } else {
                            console.error(ip, 'Shall never be here', data);
                        }
                    } catch (e) {
                        console.error('Can not process message:', data, e);
                    }
                });
            } else if (arraysAreEqual(url, ['web'])) {
                const lambda = this.allPropsFor.get('web');
                let dispose: Disposable[] = [];
                if (lambda) {
                    lambda()
                        .then(allProps => {
                            allProps.forEach(propArr => {
                                propArr.forEach(prop => {
                                    dispose.push(prop.onChange(() => {
                                        this.broadcastToWebClients({
                                            type: "onPropChanged",
                                            id: prop.id,
                                            name: prop.name,
                                            val: prop.htmlRenderer.toHtmlVal(prop.get())
                                        });
                                    }));
                                });
                            });
                        })
                        .catch(e => {
                            console.error(e);
                        });
                }

                // This is web client. Let's report server revision
                this.serverHashIdPromise.then((hashId) => {
                    ws.send(JSON.stringify({ type: 'serverVersion', val: hashId }));
                });

                ws.on('message', (message: string) => {
                    const msg = JSON.parse(message);
                    if (msg.type === "setProp") {
                        const prop = ClassWithId.byId<Property<any>>(msg.id);
                        if (prop) {
                            if (isWriteableProperty(prop)) {
                                prop.set(msg.val);
                            } else {
                                console.error(`Property ${prop.name} is not writable`);
                            }
                        } else {
                            console.error(`Property with id = ${msg.id} is not found`);
                        }
                    } else if (msg.type === 'getPropList') {
                        ws.send(JSON.stringify(this.controllers.map(ct => ({
                            name: ct.name,
                            props: ct.properties().map(prop => ({ 
                                name: prop.name, 
                                id: prop.id, 
                                val: (prop.htmlRenderer.toHtmlVal || (x => x))(prop.get())
                            }))
                        }))));
                    } else {
                        //log the received message and send it back to the client
                        this.log('received: ' + message);
                    }
                });

                ws.on('close', (message: string) => {
                    dispose.forEach(d => d.dispose());
                    dispose = [];
                });
            } else {
                this.log("WTH??? " + url);
            }

            //send immediatly a feedback to the incoming connection    
            // ws.send('Hi there, I am a WebSocket server');
        });
        this.wss.on('error', (error: Error) => {
            this.log("Error! " + error.message);
        });

        const router = express.Router()

        router.use(express.static("web"));
        router.get('/', (req, res) => {
            res.redirect('/index.html');
        });
        router.use('/static', express.static(path.normalize(__dirname + '/../web/production')));
        router.use('/tablet', express.static(path.normalize(__dirname + '/../web/tablet')));
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
            res.json(Array.from(this.tablets.values()).map(d => {
                return {
                    id: d.id,
                    name: d.name
                }
            }));
        });
        router.post('/tablet_tap', (req, res) => {
            const tabletId = req.query['id'];
            const tbl = this.tablets.get(tabletId);

            if (tbl) {
                tbl.shellCmd(`input tap ${req.query['x']} ${req.query['y']}`);
            }
        });

        let nologoBuffer: Buffer; // Cache 'nologo' because it will be used often
        router.get('/get_tv_channel_logo', async (req, res) => {
            const n: string = req.query['name'];
            const hd = homedir();
            const dn = hd + "/.tvlogos/";
            const fn = dn + n + ".png";

            if (await util.promisify(fs.exists)(fn)) {
                const content = await ((util.promisify(fs.readFile))(fn));
                res.contentType('image/png');
                res.end(content);
            } else {
                const buf = (await curl.getBin("https://github.com/AlexELEC/channel-logos/blob/master/logos/" + encodeURIComponent(n) + ".png?raw=true")).body;
                if (!fs.existsSync(dn)) {
                    fs.mkdirSync(dn);  
                }
                (util.promisify(fs.writeFile))(fn, buf);
                res.contentType('image/png');
                res.end(buf);
            }
        });
        router.get('/get_tv_logo', async (req, res) => {
            const n: string = req.query['name'];
            const ytb: string = req.query['ytb'];
            if (n) {
                const names = [
                    n,
                    n.replace(/\s*\d+\s*/gi, ""), 
                    n.replace(/\s*HD\s*/gi, ""), 
                    n.replace(/\s*\(.*\)\s*/gi, "")];
                names.sort((s1, s2) => -s1.localeCompare(s2));
                const namesDistinct = names.reduce((prev: string[], curr) => {
                    if (prev.length == 0 || curr !== prev[prev.length - 1]) {
                        return Array.prototype.concat(prev, [curr]);
                    } else {
                        return prev;
                    }
                }, []);
                // this.log(names, namesDistinct);
                Promise.all(namesDistinct.map((n: string) => { 
                    return nodeutil.promisify(fs.stat)(__dirname + '/../web/logos/' + n + '.png')
                        .then(st => [st, n] as [fs.Stats, string])
                        .catch((e: Error) => {})
                    })).then(all => {
                        const filtered = all.filter(stn => stn && stn[0].size > 0);
                        const process = (err?: NodeJS.ErrnoException, buf?: Buffer) => {
                            if (!!err) {
                                if (err.code === 'ENOENT') {
                                    const acceptDef = (err?: Error, buf?: Buffer) => {
                                        if (!!buf) {
                                            if (nologoBuffer !== buf) {
                                                nologoBuffer = buf;
                                            }
                                            res.contentType('image/png');
                                            res.end(buf);
                                        }
                                    }
                                    if (nologoBuffer) {
                                        acceptDef(undefined, nologoBuffer);
                                    } else {
                                        fs.readFile(path.normalize(__dirname + '/../web/logos/nologo.png'), acceptDef);
                                    }
                                } else {
                                    this.log(err.toString());
                                }
                            } else {
                                res.contentType('image/png');
                                res.end(buf)
                            }
                        };
                        if (filtered.length > 0 && !!filtered[0]) {
                            const first = filtered[0];
                            if (!!first) {
                                fs.readFile(path.normalize(__dirname + '/../web/logos/' + first[1] + '.png'), process);
                            }
                        } else {
                            process({ code: 'ENOENT' } as NodeJS.ErrnoException, undefined);
                        }
                    });
            } else if (!!ytb) {
                try {
                    const resInfo = await getYoutubeInfoById(ytb, (await this.keysSettings.read()).youtubeApiKey);
                    res.redirect(resInfo.thumbnailUrl);
                } catch (e) {
                    console.error(ytb);
                    console.error(e);
                }
            }
        });
        router.get('/tablet_screen', (req, res) => {
            const tabletId = req.query['id'];
            const tbl = this.tablets.get(tabletId);

            if (tbl) {
                tbl.screenshot()
                    .then(buf => {
                        res.contentType('image/png');
                        buf.pipe(res);
                    });
            }
        });
        router.get('/tablet.html', (req, res) => {
            const tabletId = req.query['id'];
            const tbl = this.tablets.get(tabletId);

            if (tbl) {
                const tabletId = querystring.escape(req.query['id']);
                res.contentType('html');
                res.send(wrapToHTML(["html", { lang: "en" }],
                    [
                        wrapToHTML("head", [
                            wrapToHTML(["meta", { 'http-equiv': "content-type", content: "text/html; charset=UTF-8" }]),
                            wrapToHTML(["meta", { name: "viewport", content: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" }], undefined),
                            wrapToHTML(["script", { type: "text/javascript" }],
                            `
                            function sendReq(url, resFn) {
                                var xhr = new XMLHttpRequest();
                                xhr.open("POST", url, true);
                                xhr.onload = function() { 
                                    if (resFn) {
                                        resFn(xhr.responseText);
                                    } 
                                };
                                xhr.send(); 
                            }
                    
                            window.onload = function() {
                                var scr = document.getElementById('mainScr');
                                scr.onclick = (e) => {
                                    console.log(e.clientX, e.clientY);
                                    sendReq("/tablet_tap?id=${tabletId}&x=" + e.clientX + "&y=" + e.clientY);
                                    setTimeout(() => scr.src = '/tablet_screen?id=${tabletId}&t=' + new Date().getTime(), 200);
                                }
                            }
                            `)
                        ].join("\n")) + "\n" +
                        wrapToHTML("body", [
                            wrapToHTML(["img", {
                                id: 'mainScr',
                                style: 'transform: rotate(' + [270, 0, 90, 180][tbl.orientation.get()] + 'deg);',
                                src: '/tablet_screen?id=' + tabletId
                            }])
                        ].join('\n'))
                    ].join('\n')));
            }
        });
        router.get('/index.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML('web'));
        });
        router.get('/lights.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML('lights', (renderer, prop) => {
                return renderer.body(prop, {
                    bgColor: clrFromName(prop.name),
                    padding: "6px",
                    margin: "5px"
                });
            }));
        });
        router.get('/tv.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML('iptv'));
        });
        router.get('/settings.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML('settings'));
        });
        router.get('/ir.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML('ir'));
        });
        router.get('/actions.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML('actions'));
        });
        router.get('/log.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML('log', (renderer, prop) => {
                return renderer.body(prop, {
                    padding: "4px",
                    margin: "2px"
                });
            }));
        });

        this.expressApi.use('/', router);

        adbClient.trackDevices()
            .then((tracker: Tracker) => {
                tracker.on('add', (dev: Device) => {
                    this.processDevice(dev);
                });
                tracker.on('remove', (dev: Device) => {
                    const foundDev = this.tablets.get(dev.id);
                    if (foundDev) {
                        foundDev.stop();
                    }
                });
            });

        adbClient.listDevices()
            .then((devices: Device[]) => {
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
   }

    private reloadM3uPlaylists() {
        this.parseM3Us([
            { url: "http://694510ce6a8d.akciatv.org/playlists/uplist/2391b94070dca2a446bcca8c0f152226/playlist.m3u8", source: "edem" },
            // { url: "http://triolan.tv/getPlaylist.ashx", source: "triolan"},
            // { url: "https://smarttvapp.ru/app/iptvfull.m3u", source: "smarttvapp"},
            // { url: "https://iptv-org.github.io/iptv/languages/uk.m3u", source: "iptv Ukraine"},
            // { url: "https://iptv-org.github.io/iptv/languages/ru.m3u", source: "iptv Russian"},
            // { url: "http://getsapp.ru/IPTV/Auto_IPTV.m3u", source: "Auto IPTV"},
            /*
            "http://tritel.net.ru/cp/files/Tritel-IPTV.m3u",
            "http://getsapp.ru/IPTV/Auto_IPTV.m3u",
            "https://webarmen.com/my/iptv/auto.nogrp.m3u",
            "https://smarttvnews.ru/apps/Channels.m3u"
            */
        ]).then(channels => {
            this.tvChannels.change(conf => {
                this.log('Parsed ' + channels.length + " IPTV channels");
                conf.channels = channels;
                conf.lastUpdate = new Date().getTime();
            });
        });
    }

    private async renderToHTML(idToReferesh: WebPageType, getBody: (renderer: HTMLRederer<any>, prop: Property<any>) => string = (renderer, prop) => renderer.body(prop)): Promise<string> {
        const allProps = await this.allPropsFor.get(idToReferesh)!();
        const propChangedMap = allProps.map((props, ctrlIndex) => {
            return props.map((prop: Property<any>, prIndex: number): string => {
                return `'${prop.id}' : (val) => { ${prop.htmlRenderer.updateCode(prop)} }`
            }).join(',\n');
        }).join(',\n');

        const hdr = [
            wrapToHTML(["meta", { 'http-equiv': "content-type", content: "text/html; charset=UTF-8" }]),
            wrapToHTML(["meta", { name: "viewport", content: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" }], undefined),
            wrapToHTML(["script", { type: "text/javascript" }],
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
                        } else if (d.type === 'reloadProps' && d.value === '${idToReferesh}') {
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

            function copyToClipboard(text) {
                var textField = document.createElement('textarea');
                textField.innerText = text;
                document.body.appendChild(textField);
                textField.select();
                document.execCommand('copy');
                textField.remove();
            }

            function sendVal(id, name, val) {
                sock.send(JSON.stringify({ 
                    type: 'setProp',
                    id: id,
                    name: name,
                    val: val }));
            };
            `)
        ];
        return wrapToHTML(["html", { lang: "en" }],
            wrapToHTML("head", hdr.join("\n")) + "\n" +
            wrapToHTML("body", allProps.map((ctrl) => {
                return "<div style='margin-top: 6px; margin-bottom: 3px; border-top: 1px solid grey;'>" + ctrl.map((prop: Property<any>): string => {
                    let res = "";

                    res = getBody(prop.htmlRenderer, prop);

                    return res;
                }).join("&nbsp;\n") + "</div>";
            }).join("\n"))
        );
    }

    private processDevice(device: Device): void {
        // Wait some time for device to auth...
        if (device.type !== 'offline') {
            delay(1000).then(() => {
                const table = this.tablets.get(device.id);
                if (table) {
                    this.log('device - INIT ' + device.id + " " + device.type);
                    table
                        .init()
                        .catch(e => { console.log('Device - err', device.id, e); });
                }
            });
        }
    }

    public listen(port: number, errCont: any) {
        this.server.listen(port, errCont);
    }

    private broadcastToWebClients(arg: Object): void {
        // console.trace();
        this.wss.clients.forEach(cl => {
            if (cl.url === 'web') {
                try {
                    cl.send(JSON.stringify(arg));
                } catch (e) {
                    // Ignore it
                }
            }
        });
    }

    public nameFromUrl(url: string): Promise<string> {
        return this.channelsHistoryConf.read()
            .then(async c => {
                const f = c.channels.find(x => x.url === url && x.name != x.url);
                if (f) {
                    return Promise.resolve(f.name);
                }
                const f2 = this.tvChannels.last().channels.find(x => x && x.url === url && x.name !== x.url);
                if (f2) {
                    return Promise.resolve(f2.name + " (TV)");
                }

                return getYoutubeInfo(url, (await this.keysSettings.read()).youtubeApiKey)
                    .then(u => u.title);
            });
    }

    public playChannel(t: Tablet, c: Channel): Promise<void> {
        this.log("Playing " + JSON.stringify(c) + ' as ' + getType(c));

        return this.playURL(t, c.url, c.name);
    }

    public async playURL(t: Tablet, _url: string, _name: string): Promise<void> {
        const url = _url.trim();

        if (!_name) {
             _name = await doWithTimeout(() => this.nameFromUrl(url).catch(() => url),
                () => { console.log('Timeout getting name from ' + url); return url; },
                15000);
        } 

        this.justStartedToPlayChannel({
            url, 
            name: _name
        });

        return this.playSimpleUrl(t, url, _name);
    }

    private justStartedToPlayChannel(ch: Channel) {
        this.channelsHistoryConf.change(hist => {
            const index = hist.channels.findIndex(c => compareChannels(c, ch) === 0);
            if (index === -1) {
                hist.channels.splice(0, 0, ch);
            } else {
                // Move channel to the first place
                const c = hist.channels[index];

                hist.channels.splice(index, 1);
                hist.channels.splice(0, 0, c);
            }
        }).then(() => {
            this.reloadAllWebClients('web');
        });
        ;
    }

    private parseM3Us(urls: { url: string, source: string}[]): Promise<Channel[]> {
        return Promise.all(urls.map(_url => {
            return curl.get(_url.url).then(text => {
                const lines = splitLines(text);
                if (lines[0].match(/^.?#EXTM3U/)) {
                    lines.splice(0, 1);
                    const res: Channel[] = [];
                    lines.reduce((prev, val) => {
                        if (val.match(/^#EXTINF:/)) {
                            prev.name = (val.match(/\,(.*)$/) || ["", ""])[1].trim();
                            return prev;
                        } else if (val.match(/^#EXTVLCOPT/)) {
                            return prev; // Ignore
                        } else if (val.match(/^#EXTGRP:/)) {
                            prev.cat = (val.match(/^#EXTGRP:(.*)$/) || ["", ""])[1].trim();
                            return prev;
                        } else if (val.match(/^http/)) {
                            prev.url = val;
                            prev.source = _url.source;
                            if (!prev.name) {
                                this.log(JSON.stringify(prev));
                            }
                            res.push(prev);
                            return {} as Channel;
                        }
                        return prev;
                    }, {} as Channel);

                    return (res as Channel[]).filter(v => v && v.url);

                } else {
                    throw new Error('Invalid format for ' + _url);
                }
            }).catch(e => console.error(e));
        })).then(arr => {
            const res = Array.prototype.concat(...arr);
            res.sort((a, b) => a.name.localeCompare(b.name));
            // console.log(res);
            return res;
        });
    }
  
    public async playSimpleUrl(t: Tablet, url: string, name: string) {
        if (!t.screenIsOn.get()) {
            await t.screenIsOn.set(true);
        }

        // this.r2.switch(true);

        this.allInformers.runningLine("Включаем " + name + " на " + t.shortName, 3000);
        
        this.log('playSimpleUrl ' + url);
        t.playURL(url);
    }

    private rebootService(): void {
        runShell("/bin/systemctl", ["restart", "nodeserver"]);
    }

    private async getMemInfo(): Promise<MemInfo> {
        return new Promise((accept, reject) => {
            fs.exists('/proc/meminfo', (exists) => {
                if (exists) {
                    fs.readFile('/proc/meminfo', 'utf8', function(err, contents) {
                        if (err) {
                            reject(err);
                        } else {
                            const res = {} as MemInfo;
                            const lines = splitLines(contents);
                            lines.forEach(l => {
                                const splitl = l.split(/:?\s+/).map(s => s.trim());
                                const name = splitl[0];
                                const val = +(splitl[1]);
                                res[name] = val;                    
                            });
                            
                            accept(res);
                        }
                    });        
                }
            });    
        });
        
    }

    async sound(controller: ClockController, type: SoundType): Promise<void> {
        const snd = (await this.keysSettings.read())[type];
        if (snd !== null) {
            // If there is a day - play full sound, at night - play only half
            if (controller.screenEnabledProperty.get()) {
                controller.play((await this.isNightMode()) ? snd.volume * 4 / 10 : snd.volume, snd.index);
            } else {
                console.log("Silent because switched off");
            }
        } else {
            this.log('No sound set for ' + type);
        }
    }

    public async isNightMode(): Promise<boolean> {
        const keys: KeysSettings = await this.keysSettings.read();
        const now = nowHourMin();
        return hourMinCompare(keys.dayBeginsAt, now) >= 0 || hourMinCompare(now, keys.dayEndsAt) >= 0;
    }

    private createClockController(hello: Hello, ip: string, handlers: ClockControllerCommunications): ClockController {
        const clockController: ClockController = new ClockController(handlers, ip, hello, {
            onDisconnect: () => {
                this.log(ip + ' DISCONNECT');
                // console.trace();
                this.dynamicControllers.delete(ip);
                if (clockController.lcdInformer) {
                    this.allInformers.delete(ip);
                }
                this.reloadAllWebClients('web');
                this.allInformers.runningLine('Отключено ' + clockController.name, 3000);
            },
            onWeatherChanged: (val) => {
                this.weatherChanged(val.temp, val.pressure, val.humidity);
            },
            onWeightChanged: (weight: number) => {
                this.allInformers.staticLine(weight + "г");
            },
            onWeightReset: () => {
                this.allInformers.staticLine("Сброс");
            },
            onPotentiometer: (value: number) => {                                   
                return this.onPotentiometer(clockController, value);
            },
            onRawIrKey: async (timeSeq: number, periods: number[]) => {
                return this.onRawIRKey(clockController, timeSeq, periods);
            },
            onRawDestinies: async (timeSeq: number, periods: number[]) => {
                return this.onRawDestinies(clockController, timeSeq, periods);
            },
            onIRKey: (remoteId: string, keyId: string) => {
                this.onIRKey(remoteId, keyId, clockController);
            }
        } as ClockControllerEvents);
        this.dynamicControllers.set(ip, clockController);
        if (clockController.lcdInformer) {
            this.allInformers.set(ip, clockController.lcdInformer);
        }
        if (clockController.hasScreen()) {
            clockController.screenEnabledProperty.set(!this.isSleeping);
            delay(100).then(() => {
                clockController.send({ type: 'unixtime', value: Math.floor((new Date()).getTime() / 1000) });
            });
        }

        this.log('Connected ' + clockController.name + ' (' + clockController.ip + ')');

        setInterval(() => {
            handlers.send( { type: 'ping', pingid: '' } );
        }, 10000);

        return clockController;
    }

    private onPotentiometer(clockController: ClockController, value: number): void {
        if (clockController.hasScreen()) {
            // Let's tune screen brightness
            // adc value is from 0 (nuke bright) to 1024 (absolutely dark)
            // 
            clockController.brightnessProperty.set(Math.floor((1024 - value) / 18));
        }
    }

    private weatherChanged(temp: number | undefined, pressure: number | undefined, humidity: number | undefined): void {
        this.allInformers.additionalInfo(
            Array.prototype.concat(
                temp ? [tempAsString(temp)] : [],
                pressure ? ["давление " + toFixedPoint(pressure*0.00750062, 1) + "мм рт ст"] : [],
                humidity ? ["влажность " + toFixedPoint(humidity, 1) + "%"] : [],
                [this.nowWeather.get()]
            ).filter(x => !!x).join(', '));
    }

    private async addPullup() {
        const resInfo = await addPullup((await this.keysSettings.read()).spreadsheetsApiKey);

    }

    private test(): void {
        this.addPullup()
    }

    private test2(): void {
        for (const inf of this.dynamicControllers.values()) {
            if (inf.hasScreen()) {
                let t = inf.lastMsgLocal + 200;
                const tStep = 1000;
                for (let i = 0; i < 10; ++i, t+=tStep) {
                    inf.send({
                        type: 'screen',
                        content: { 
                            width: 32, 
                            height: 8, 
                            content: Buffer.from(Array.from({ length: 32}).map((x, ii) => [ 0xff, 0, 0xff, 0, 0xaa] [i % 5]))
                        },
                        offsets: [{ 
                            x: i == 0 ? 0 : -32, 
                            y: 0,
                            at: i == 0 ? t : t - tStep
                        }, {
                            x: 32,
                            y: 0, 
                            at: t + tStep
                        }] });
                }
            }
        }
    }
}

type MemInfo = { [key: string]: number };

process.on('uncaughtException', (err: Error) => {
    console.error(err.stack);
    console.log("Node NOT Exiting...");
});

process.on('unhandledRejection', (reason: Error | any, p: Promise<any>) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    // application specific logging, throwing an error, or other logic here
});

export default new App()