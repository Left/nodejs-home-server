import * as express from 'express'
import * as http from 'http';
import * as WebSocket from 'ws';
// import * as stream from "stream";
import * as fs from "fs";
import * as nodeutil from "util";
import * as path from "path";
import * as dgram from "dgram";
import * as crypto from 'crypto';
import * as querystring from 'querystring';

import * as curl from "./http.util";
import * as util from "./common.utils";
import { getYoutubeInfo, parseYoutubeUrl, getYoutubeInfoById } from "./youtube.utils";
import { Relay, Controller, newWritableProperty, CheckboxHTMLRenderer, SliderHTMLRenderer, Property, ClassWithId, SpanHTMLRenderer, Button, WritablePropertyImpl, SelectHTMLRenderer, isWriteableProperty, StringAndGoRendrer, ImgHTMLRenderer, Disposable, OnOff, HTMLRederer } from "./properties";
import { TabletHost, Tablet, adbClient, Tracker, Device } from "./android.tablet";
import { CompositeLcdInformer } from './informer.api';
import { ClockController, Hello, ClockControllerEvents } from './esp8266.controller';

import * as protocol from "./protocol_pb";
import { doWithTimeout } from './common.utils';

class GPIORelay extends Relay {
    private _init: Promise<void>;
    private _modeWasSet: boolean = false;
    static readonly gpioCmd = "/root/WiringOP/gpio/gpio";

    constructor(readonly name: string, public readonly pin: number, private readonly conf: util.Config<{ relays: boolean[] }>, private readonly index: number, location: string) {
        super(name, location);

        this.conf.read().then(conf => this.setInternal(conf.relays[this.index]));

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
                util.runShell(GPIORelay.gpioCmd, ["-1", "mode", "" + this.pin, "out"])
                    .then(() => Promise.resolve(void 0))
                    .catch(err => console.log(err.errno)));
        }

        return this._init.then(() => {
            return util.runShell(GPIORelay.gpioCmd, ["-1", "write", "" + this.pin, on ? "0" : "1"])
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

    constructor(private config: util.Config<MiLightBulbState>) {
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

interface IRKeysHandler {
    remote?: string;
    /**
     * This method should check array and return milliseconds before accepting
     */
    partial(remoteId: string, arr: string[], final: boolean, timestamps: number[]): number | null;
    /**
     * Accept the command
     */
    complete(remoteId: string, arr: string[], timestamps: number[]): void;
}

type ChannelType = 'Url' | 'Youtube';

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

type TimerProp = { val: Date | null, controller: Controller, fireInSeconds: (sec: number) => void };

type Labeled = {
    lbl: string;
};
type Action = Labeled & {
    action: () => {};
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

interface KeysSettings {
    weatherApiKey: string;
    youtubeApiKey: string;
    simulateSomeoneIsAtHome: string;
}

function clrFromName(name: string) {
    const x = crypto.createHash('md5').update(name).digest("hex").substr(0, 6);
    return "#" + x.split(/(.{2})/).filter(O=>O).map(x => {
        // console.log(x, (Number.parseInt(x, 16));
        const xx = '00' + (255 - Math.trunc(Number.parseInt(x, 16) / 2)).toString(16);
        return xx.slice(xx.length - 2);
    }).join('');
}


class App implements TabletHost {
    public expressApi: express.Express;
    public server: http.Server;
    public readonly wss: WebSocket.Server;
    public currentTemp?: number;
    public isSleeping: boolean = false;

    private gpioRelays = util.newConfig({ relays: [false, false, false, false] }, "relays");

    private r1 = new GPIORelay("Лента на шкафу", 38, this.gpioRelays, 0, "Комната");
    // private r2 = new GPIORelay("Розетка 0", 40, this.gpioRelays, 1, "Комната");
    private r3 = new GPIORelay("Коридор", 36, this.gpioRelays, 2, "Коридор");
    private r4 = new GPIORelay("Лампа на шкафу", 32, this.gpioRelays, 3, "Комната");
    // private r5 = new GPIORelay("R5", 37, this.gpioRelays, 4);
    // private r6 = new GPIORelay("R6", 35, this.gpioRelays, 5);
    // private r7 = new GPIORelay("R7", 33, this.gpioRelays, 6);
    // private r8 = new GPIORelay("R8", 31, this.gpioRelays, 7);

    private allowRenames = false;

    private ctrlGPIO = {
        name: "Комната",
        properties: () => [this.r1, /*this.r2,*/ this.r4, this.r3, /*this.r5, this.r6, this.r7, this.r8 */ ]
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


    private miLightNow = { on: false, brightness: 0, hue: 0, allWhite: true };
    private miLightState = util.newConfig(this.miLightNow, "miLight");

    private readonly miLight = new MiLightBulb(this.miLightState);

    private readonly kindle: Tablet = new Tablet('192.168.121.166:5555', 'Kindle', this, true);
    private readonly nexus7: Tablet = new Tablet('00eaadb6', 'Nexus', this, false);
    private readonly nexus7TCP: Tablet = new Tablet('192.168.121.172:5555', 'Nexus TCP', this, true);

    private readonly tablets: Map<string, Tablet> = new Map(
        [this.kindle, this.nexus7, this.nexus7TCP].map(t => [t.id, t] as [string, Tablet])
    );

    private readonly lat = 44.9704778;
    private readonly lng = 34.1187681;

    private timeProp(name: string, upto: number, onChange: (v: number) => void): WritablePropertyImpl<number> {
        return newWritableProperty<number>(
            name,
            0,
            new SelectHTMLRenderer<number>(Array.from({ length: upto }, ((v, k) => k)), i => "" + i),
            { onSet: (v: number) => { onChange(v); }});
    }

    private createTimer(name: string, 
        confName: string, 
        onFired: ((d: Date, soundNo: number, vol: number) => void),
        noSound: boolean): TimerProp {
        interface Conf {
            val: string | null;
            soundNo?: number;
            soundVol?: number;
        }

        const conf = util.newConfig({ val: null } as Conf, confName);
        conf.read().then(conf => {
            // Prop was read, let's set props
            setNewValue(conf.val ? new Date(conf.val) : null);
            soundNoProp.setInternal(conf.soundNo || 105);
            volProp.setInternal(conf.soundVol || 60);
        })

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
        const inProp = newWritableProperty<number|undefined>("через", 0,
            new SpanHTMLRenderer<number>(n => n === undefined ? "" : util.toHourMinSec(n)));

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
                    return util.toHourMinSec(+n.slice(3));
                } else if (n === "never") {
                    return "никогда";
                } else if (n === "atdate") {
                    return "в момент";
                }
                return "";
            }),
            { onSet: (_n: number) => {
                const n = timerIn[_n];
                if (n.startsWith("val")) {
                    that.fireInSeconds(+n.slice(3));
                } else if (n === "never") {
                    setNewValue(null);
                } else if (n === "atdate") {
                    onDateChanged();
                }
            }});
        var timers: NodeJS.Timer[] = [];
        let intervalTimer: NodeJS.Timer;
        const setNewValue = (d: Date | null) => {
            console.log(name + " --> " + d);
            if (d !== that.val) {
                // that.val === undefined || that.val.getTime() != d.getTime())) {
                timers.forEach(t => clearTimeout(t));
                timers = [];

                if (intervalTimer) {
                    clearInterval(intervalTimer);
                }
                if (d) {
                    intervalTimer = setInterval(() => {
                        if (that.val) {
                            inProp.setInternal(Math.floor((that.val.getTime() - Date.now())/1000));
                        } else {
                            inProp.setInternal(undefined);
                        }
                    }, 1000);
                } else {
                    inProp.setInternal(undefined);
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
                    timers.push(setTimeout(() => {
                        onFired(tt, soundNoProp.get() + 1, volProp.get());
                        setNewValue(null);
                    }, msBefore));
                    [45, 30, 20, 15, 10, 5, 4, 3, 2, 1].forEach(m => {
                        const msB = msBefore - m*60*1000;
                        if (msB > 0) {
                            timers.push(setTimeout(() => {
                                // 
                                console.log(m + ' минут до ' + name);
                                this.allInformers.runningLine(m + ' минут до ' + name.toLowerCase(), 3000);
                            }, msB));
                        }
                    });
                    conf.change({ val: that.val!.toJSON() });
                } else {
                    // Dropped timer
                    // hourProp.setInternal(0);
                    // minProp.setInternal(null);
                    // secProp.setInternal(null);
                    hourProp.setInternal(0);
                    minProp.setInternal(0);
                    secProp.setInternal(0);
                    orBeforeProp.setInternal(0);
                    conf.change({ val: null });
                }
            }
        }

        const soundNoProp = newWritableProperty("Sound no", 
            0, 
            new SelectHTMLRenderer<number>(Array.from({ length: ClockController.mp3Names.length }, ((v, k) => k)), i => i + ". " + ClockController.mp3Names[i]), 
            {
                onSet: (val) => {
                    conf.change(t => t.soundNo = +val);
                }
            });
        const volProp = newWritableProperty("Vol", 
            60,
            new SliderHTMLRenderer(), 
            {
                onSet: (val: number) => {
                    conf.change(t => t.soundVol = val);
                }
            });

        const that = {
            val: null as Date | null,
            controller: {
                name: name,
                properties: () => [
                    hourProp, minProp, secProp, orBeforeProp, inProp
                ].concat(noSound ? [] : [ soundNoProp, volProp ])
            },
            fireInSeconds: (sec: number) => {
                const d = new Date();
                d.setTime(d.getTime() + sec * 1000);
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

    public sleepAt = this.createTimer("Выкл", "off", async (d, soundNo, vol) => {
        this.isSleeping = true;
        console.log("SLEEP", d);
        const wasOnIds = [];
        for (const ctrl of this.controllers) {
            for (const prop of ctrl.properties()) {
                if (prop instanceof Relay) {
                    if (prop.get()) {
                        wasOnIds.push(prop.id);
                    }
                    prop.set(false);
                    await util.delay(1000);
                }
            }
        }
        const clock = this.findDynController('ClockNRemote');
        if (clock) {
            await util.delay(500);
            clock.screenEnabledProperty.set(false);
        }
        const ledStripe = this.findDynController('LedStripe');
        if (ledStripe) {
            ledStripe.screenEnabledProperty.set(false);
        }
        const ledController1 = this.findDynController('LedController1');
        if (ledController1) {
            ledController1.screenEnabledProperty.set(false);
        }

        this.relaysState.wasOnIds = wasOnIds;
    }, true);

    public timer = this.createTimer("Таймер", "timer", (d, soundNo, vol) => {
        console.log("Timer!");

        this.allInformers.staticLine("Время!");
/*
        const kr = this.findDynController('RelayOnKitchen');
        if (kr) {
            async function blinkKitchenStripe(stripeRelay: Relay) {
                const wasOn = stripeRelay.get();
                for (var i = 0; i < 3; ++i) {
                    stripeRelay.set(false);
                    await util.delay(600);
                    stripeRelay.set(true);
                    await util.delay(600);
                }
                stripeRelay.set(wasOn);
            }
            blinkKitchenStripe(kr.relays[1]);
            blinkKitchenStripe(this.r3);
        }
*/
        for (const c of ['ClockNRemote', 'KitchenRelay']) {
            const cr = this.findDynController(c);
            if (cr) {
                cr.setVol(vol);
                cr.playMp3(soundNo);
            }
        }
    }, false);

    public wakeAt = this.createTimer("Вкл", "on", (d, soundNo, vol) => {
        console.log("WAKE", d);
        this.isSleeping = false;
        //this.nexus7.screenIsOn.set(true);
        // for (const wo of this.relaysState.wasOnIds) {
        //     (ClassWithId.byId(wo) as Relay).set(true);
        // }
        const wake = async () => {
            this.allInformers.runningLine("Просыпаемся...", 10000);

            // await util.delay(2000);
            // this.miLight.brightness.set(10);
            // await util.delay(100);
            // this.miLight.allWhite.set(true);
            // await util.delay(100);
            // this.miLight.switchOn.set(true);

            this.kindle.screenIsOn.set(true);
            await util.delay(100)
            this.kindle.volume.set(20);
            await util.delay(100)
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
                clock.setVol(vol);
                clock.playMp3(soundNo);
            } 

            // await util.delay(3000);
            // this.r1.switch(true);

            // this.miLight.brightness.set(80);
        }
        wake();
    }, false);

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
                    console.log('Low memory: ', freeMem);
                    this.allInformers.runningLine('На сервере мало памяти', 3000);
                }
                if (freeMem < 8 && !startedRebooting) {
                    startedRebooting = true;
                    this.allInformers.runningLine('Перегружаем сервис - осталось совсем мало памяти', 3000);
                    util.delay(2000).then(() => this.rebootService());
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
            Button.create("Reboot Orange Pi", () => util.runShell("reboot", [])),
            Button.createClientRedirect("TV Channels", "/tv.html"),
            Button.create("Reload TV channels", () => this.reloadM3uPlaylists()),
            Button.createClientRedirect("Lights", "/lights.html"),
            Button.createClientRedirect("Settings", "/settings.html"),
            newWritableProperty<boolean>("Allow renames", this.allowRenames, new CheckboxHTMLRenderer(), { onSet: (val: boolean) => {
                this.allowRenames = val;
                this.reloadAllWebClients('web');
            }}),
            this._freeMem
        ]
    }

    private tvChannels = util.newConfig({ channels: [] as Channel[], lastUpdate: 0 }, "m3u_tv_channels");
    private channelsHistoryConf = util.newConfig({ channels: [] as Channel[] }, "tv_channels");
    private keysSettings = util.newConfig({ 
        weatherApiKey: "",
        youtubeApiKey: "",
        simulateSomeoneIsAtHome: ""
    }, "keys");
    // private actions = util.newConfig({ actions: [] as PerformedAction[] }, "actions");

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
                            'Url': () => "https://github.com/AlexELEC/channel-logos/blob/master/logos/" + encodeURIComponent(h.name) + ".png?raw=true"
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

    private renderChannels() {
        const chToHist = new Map();
        this.channelsHistoryConf.last().channels.forEach(element => {
            if (!!element.channel) {
                chToHist.set(element.channel, element);
            }
        });

        // channelsProto contains all channels that are not used yet
        const channelsProto = Array.from({ length: 99 }, (e, i) => i).filter(ch => !chToHist.has(ch));
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

    private allPropsFor: Map<string, () => Promise<Property<any>[][]>> = new Map([
        ['web', async () => this.controllers.map((ctrl) => {
            return Array.prototype.concat(
                ctrl.name ? [ newWritableProperty("", ctrl.name, new SpanHTMLRenderer()) ] : [], 
                ctrl.properties());
        })],
        ["iptv", async () => this.tvChannels.last().channels.filter(h => h).map((h, index) => {
            return Array.prototype.concat(
                [ newWritableProperty("", "" + index + ".", new SpanHTMLRenderer()) ], 
                [ newWritableProperty("", [h.name, h.source ? ('(' + h.source + ')') : undefined].filter(x => !!x).join(" "), new SpanHTMLRenderer()) ],
                [ newWritableProperty("", h.cat, new SpanHTMLRenderer()) ], 
                this.makePlayButtonsForChannel(h.url, t => this.playURL(t, h.url, h.name))
            );
        })],
        ["lights", async () => {
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
        ["settings", async () => {
            const keys: KeysSettings = await this.keysSettings.read();
            return Object.getOwnPropertyNames(this.keysSettings.def).map((kn2) => {
                const kn = kn2 as (keyof KeysSettings);
                const v = keys[kn];
                let ret;
                if (typeof (v) === 'string') {
                    // const strings: Extract<KeysSettings, string> = keys;
                    ret = newWritableProperty(kn, keys[kn], new StringAndGoRendrer("Change"), { onSet: (val: string) => {
                        keys[kn] = val;
                        this.keysSettings.change(keys);
                    }});
                } else {
                    console.log("Property " + kn + " has unsupported type" + typeof(v));
                    return [] as Property<any>[];
                }
   
                return [ ret ] as Property<any>[];
            });
        }],
        ["actions", async () => {
            // const actions = await this.actions.read();
            return [];
        }]
    ]);

    private reloadAllWebClients(val: string) {
        this.broadcastToWebClients({ type: "reloadProps", value: val });
    }


    private get controllers(): Controller[] {
        const dynPropsArray = Array.from(this.dynamicControllers.values());
        dynPropsArray.sort((a, b) => a.ip == b.ip ? 0 : (a.ip < b.ip ? -1 : 1));

        return Array.prototype.concat([
                this.sleepAt.controller,
                this.wakeAt.controller,
                this.timer.controller,
                this.ctrlControlOther,
                this.ctrlWeather,
                this.miLight,
            ],
            GPIORelay.gpioInstalled() ? [ this.ctrlGPIO ] : [],
            this.allOnlineTablets(),
            dynPropsArray,
            this.renderChannels()
        );
    }

    private simpleCmd(prefixes: string[][], showName: string, action: (remoteId: string, keys: string[]) => void): IRKeysHandler {
        return {
            partial: (remoteId, arr, finalCheck) => {
                if (prefixes.some(prefix => util.arraysAreEqual(prefix, arr))) {
                    return 0; // Accept immediatelly
                }

                if (prefixes.some(prefix => util.arraysAreEqual(prefix.slice(0, arr.length), arr))) {
                    return 1500; // Wait for cmd to complete
                }
                return null;
            },
            complete: (remoteId, arr) => {
                this.allInformers.runningLine(showName, 2000);
                action(remoteId, arr);
            }
        } as IRKeysHandler;
    }

    private createPowerOnOffTimerKeys(prefix: string, actions: () => { showName: string, valueName?: string, action: (dd: number) => void }[]): IRKeysHandler {
        return {
            partial: (remoteId, arr, finalCheck) => {
                const firstNonPref = util.getFirstNonPrefixIndex(arr, prefix)
                if (firstNonPref == 0 || arr.slice(firstNonPref).some(x => !util.isNumKey(x))) {
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
                    this.allInformers.staticLine(util.numArrToVal(arr.slice(firstNonPref)) + (a.valueName || ""));
                    return 2000;
                }
            },
            complete: (remoteId, arr) => {
                const firstNonPref = util.getFirstNonPrefixIndex(arr, prefix)
                const dd = util.numArrToVal(arr.slice(firstNonPref));
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
            timer: { val: Date | null, fireInSeconds: (sec: number) => void}): void {
        timer.fireInSeconds(val);
        util.delay(3000).then(() => 
            this.allInformers.runningLine(name + " в " + util.toHMS(timer.val!), 3000) );
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

    private makeUpDownKeys(keys: {keys: string[], remoteId?: string, action: (remoteId: string, key: string) => void}[], delay: number = 2500): IRKeysHandler {
        return {
            partial: (remoteId, arr, final) => {
                const allAreVolControls = arr.length > 0 && arr.every(k => keys.some(kk => kk.keys.indexOf(k) !== -1));
                if (allAreVolControls) {
                    if (!final) {
                        const last = arr[arr.length - 1];
                        const kk2 = keys.find(kk => 
                            (kk.keys.indexOf(last) !== -1) && 
                            (!kk.remoteId || kk.remoteId == remoteId));
                        if (kk2) {
                            kk2.action(remoteId, last)
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

    private dayBeginsTimer: util.Disposable = util.emptyDisposable;
    private dayEndsTimer: util.Disposable = util.emptyDisposable;

    private dayBegins() {
        this.isSleeping = false;
        const clock = this.findDynController('ClockNRemote');
        if (clock) {
            clock.screenEnabledProperty.set(true);

            if (clock.lcdInformer) {
                clock.lcdInformer.runningLine("Рассвет", 3000);
            }
        }
        const kr = this.findDynController('KitchenRelay');
        if (kr) {
            kr.screenEnabledProperty.set(true);
        }
        
        this.miLight.brightness.set(50);
    }

    private async switchLightOnWaitAndOff() {
        this.miLight.switchOn.set(true);
        await util.delay(300);
        this.miLight.brightness.set(70);
        await util.delay(300);
        this.miLight.allWhite.set(true);
        await util.delay(3*60*60*1000); // In 3 hours, switch the light off
        this.miLight.switchOn.set(false);
        console.log('Switch light off');    
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
            if (keys.simulateSomeoneIsAtHome === 'true') {
                // await util.delay(Math.random()*30*60*1000); // Wait [0..30] minutes
                console.log('Switch light on');
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
        const dynSwitchers = ['RoomSwitchers', 'RelayOnKitchen']
                    .map(name => {
                        const dc = this.findDynController(name);
                        return (dc ? dc.relays : []) as OnOff[];
                    });

        const ledStripe = this.findDynController('LedStripe');
        
        return ([
                this.miLight.switchOn,
                this.r1,
                this.r3,
                this.r4,
            ] as OnOff[])
            .concat(...dynSwitchers)
            .concat(...(ledStripe ? [ 
                new (class R extends Relay {
                    public get(): boolean {
                        return ledStripe.ledStripeColorProperty.get() !== '00000000';
                    }
                    public switch(on: boolean): Promise<void> {
                        ledStripe.ledStripeColorProperty.set(on ? '000000FF' : '00000000');
                        return Promise.resolve(void 0);
                    }
                })('Лента на двери', 'Комната')] : []))
            .concat(...([
                    ['LedController1', 'Лента на столе', 'Комната'], 
                    ['SmallLamp', 'Маленькая лампа на столе', 'Комната']
                ]
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
            .filter(v => v.name);
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
            
        }),
        this.simpleCmd([["record"]], "Лента на шкафу", () => {
            this.r1.switch(!this.r1.get());
        }),
        this.simpleCmd([['stop']], "Коридор", () => {
            this.r3.switch(!this.r3.get());
        }),
        this.simpleCmd([['time_shift']], "Потолок в комнате", () => {
            const roomSwitch = this.findDynController('RoomSwitchers');
            if (roomSwitch) {
                roomSwitch.relays[2].switch(!roomSwitch.relays[2].get());
            }
        }),
        this.simpleCmd([['av_source']], "Лента на двери", () => {
            const ledStripe = this.findDynController('LedStripe');
            if (ledStripe) {
                const prop = ledStripe.ledStripeColorProperty;
                prop.set(prop.get() === '00000000' ? '000000FF' : '00000000');
            }
        }),
        this.simpleCmd([['clear']], "MiLight", () => {
            this.miLight.switchOn.switch(!this.miLight.switchOn.get());
        }),

        this.simpleCmd([['mts']], "Потолок на кухне", () => {
            this.toggleRelay('RelayOnKitchen', 0);
        }),
        this.simpleCmd([['min']], "Лента на кухне", () => {
            this.toggleRelay('RelayOnKitchen', 1);
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
                if (remote === 'tvtuner') {
                    tablet = this.nexus7TCP;
                }
                if (!tablet.screenIsOn.get()) {
                    tablet.screenIsOn.set(true);
                }
                tablet.volume.set(tablet.volume.get() + (key === 'volume_up' ? +1 : -1) * 100 / 15)
            }}
        ]),
        this.simpleCmd([['click']], "MiLight", (remoteId, keys) => {
            const clock = this.findDynController('ClockNRemote');

            if (remoteId == 'encoder_middle') {
                const onNow = this.miLight.switchOn.get();
                this.miLight.switchOn.switch(!onNow);

                const ledController1 = this.findDynController('LedController1');
                if (ledController1) {
                    ledController1.screenEnabledProperty.set(!onNow);
                }
        
                if (clock) {
                    clock.setVol(30);
                    clock.playMp3(onNow ? 234 : 240);
                }
            } else if (remoteId == 'encoder_left') {
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
                        clock.setVol(30);
                        clock.playMp3(onNow ? 234 : 240);
                    }
                }
            }
        }),
        this.makeUpDownKeys([
            { keys: ['rotate_cw', 'rotate_ccw'], action: (remote, key) => {
                const sign = (key === 'rotate_cw' ? +1 : -1);
                if (remote === 'encoder_left') {
                    if (!this.kindle.screenIsOn.get()) {
                        this.kindle.screenIsOn.set(true);
                    }
                    this.kindle.volume.set(this.kindle.volume.get() + sign * 100 / 15);
                } else if (remote === 'encoder_middle') {
                    const nowBr = this.modifyBrightnessMi(sign * 10);
                    const ledController1 = this.findDynController('LedController1');
                    if (ledController1) {
                        ledController1.d3PWM!.set(nowBr);
                        ledController1.d4PWM!.set(nowBr);
                    }            
                }
            }}
        ], 10),
        new (class LightMenu implements IRKeysHandler {
            constructor(private _app: App) {
            }

            public partial(remoteId: string, arr: string[], final: boolean, timestamps: number[]): number | null {
                if (remoteId === 'encoder_right') {
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

            public complete(remoteId: string, arr: string[], timestamps: number[]): void {
                if (arr.length >= 2 && arr[arr.length - 1] === 'click') {
                    const val = this.getCurrent(arr, timestamps);
                    val.switch(!val.get());
                    this._app.allInformers.runningLine('Нажат ' + val.name, 3000);
                }
            }
        })(this),
        this.makeMainMenu(menuKeys, {
            lbl: '', submenu: () => [
                { lbl: 'Свет', submenu: () =>
                    this.lights().map(x => ({
                            lbl: x.name,
                            action: () => {
                                x.switch(!x.get());
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
                            { lbl: 'Reboot', action: () => console.log('REBOOT') }
                        ]
                    } as Menu))
                }
        ]} as Menu)
    ];

    private makeMainMenu(menuKeys: MenuKeysType, menu: Menu): IRKeysHandler {
        return {
            partial: (remoteId, arr, final) => {
                const keyset = menuKeys[remoteId];
                // console.log(arr.slice(0, 1), [ keyset.menu ]);
                if (!!keyset && util.arraysAreEqual(arr.slice(0, 1), [keyset.menu])) {
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
                                res[0].action(); // Go ahead!
                            } else {
                                return 0;
                            }
                        }
                        const line = res[0].lbl;
                        console.log(line);
                        this.allInformers.runningLine(line, 8000);
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

        // console.log(prevIndex, newIndex, inArr[(newIndex + inArr.length) % inArr.length].channel);

        return inArr[(newIndex + inArr.length) % inArr.length];
    }

    public toggleRelay(internalName: string, index: number): void {
        const kitchenRelay = this.findDynController(internalName);
        if (kitchenRelay) {
            kitchenRelay.relays[index].switch(!kitchenRelay.relays[index].get());
        }
    }

    private async updateWeather() {
        const cityid = 693805;
        const keys = await this.keysSettings.read();
        const ress = await curl.get(`https://api.openweathermap.org/data/2.5/weather?id=${cityid}&mode=json&units=metric&lang=ru&APPID=${keys.weatherApiKey}`);
        const jso = JSON.parse(ress) as (WeatherInfo | WeatherError400 | WeatherError500);
        if (jso.cod === 200) {
            //jso
            // console.log(jso.weather[0]);
            const str = jso.weather[0].description + ' ' + util.tempAsString(jso.main.temp) + ' ветер ' + jso.wind.speed + 'м/c';
            console.log(str);
            this.nowWeather.set(str);
            this.nowWeatherIcon.set(`http://openweathermap.org/img/w/${jso.weather[0].icon}.png`);
        } else {
            console.log(ress);
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
                                this.reloadAllWebClients('web')
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
                            // console.log(err, bytes);
                        });
                        await util.delay(0);
                    }
                }
                await util.delay(10);
            }
        }, 3000);
        */
        
        this.channelsHistoryConf.read();        

        // Load TV channels from different m3u lists

        this.tvChannels.read().then(conf => {
            if ((new Date().getTime() - conf.lastUpdate) / 1000 > 10*60) {
                this.reloadM3uPlaylists();
            }
            console.log("Read " + conf.channels.length + " M3U channels");
        });

        const getSunrizeSunset = () => {
            const now = new Date();
            console.log('sunrise query');
            curl.get(`https://api.sunrise-sunset.org/json?formatted=0&lat=${this.lat}&lng=${this.lng}&date=${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`)
                .then(resStr => {
                    const res = JSON.parse(resStr) as SunrizeError | SunrizeDate;
                    if (res.status === 'OK') {
                        const twilightBegin = new Date(res.results.civil_twilight_begin);
                        const twilightEnd = new Date(res.results.civil_twilight_end)

                        console.log('sunrise is at ' + twilightBegin.toLocaleString());
                        this.dayBeginsTimer.dispose();
                        this.dayBeginsTimer = util.doAt(twilightBegin.getHours(), twilightBegin.getMinutes(), twilightBegin.getSeconds(), () => { this.dayBegins() });

                        console.log('sunset is at ' + twilightEnd.toLocaleString());
                        this.dayEndsTimer.dispose();
                        this.dayEndsTimer = util.doAt(twilightEnd.getHours(), twilightEnd.getMinutes(), twilightEnd.getSeconds(), () => { this.dayEnds() });
                    }
                })
        };

        util.doAt(0, 5, 0, getSunrizeSunset);
        getSunrizeSunset();

        // Each hour reload our playlists
        setInterval(() => {
            this.reloadM3uPlaylists();
        }, 1000*60*60);

        const udpServer = dgram.createSocket("udp4");
        udpServer.on('error', err => {
            console.error(err);
            udpServer.close();
        });
        udpServer.on('message', (msg, rinfo) => {
            try {
                const newLocal = protocol.SimpleMessage.deserializeBinary(msg);
                const typedMessage = newLocal.toObject();
                console.log(JSON.stringify(typedMessage, undefined, ' '));
            } catch (e) {
                // console.log()
            }
            // console.log(`server got: ${msg} from ${rinfo.address}:${rinfo.port}`);
        });
        udpServer.on('listening', () => {
            const address = udpServer.address();
            console.log(`server listening ${address.address}:${address.port}`);
        });
        udpServer.bind(8081);

        this.expressApi = express();

        this.server = http.createServer(this.expressApi);

        this.wss = new WebSocket.Server({ server: this.server });
        this.wss.on('connection', (ws: WebSocket, request) => {
            const url = (request.url || '/').split('/').filter(p => !!p);
            // console.log("Connection from", request.connection.remoteAddress, request.url);
            const remoteAddress = request.connection.remoteAddress!;
            const ip = request.connection.remoteFamily + "_" + util.parseOr(remoteAddress, /::ffff:(.*)/, remoteAddress) + ":" + request.connection.remotePort;
            ws.url = url[0];

            //connection is up, let's add a simple simple event
            if (util.arraysAreEqual(url, ['esp'])) {
                console.log(ip, "CONNECT");

                ws.on('close', (data: string) => {
                    const controller = this.dynamicControllers.get(ip);
                    console.log((controller || {name: ip}).name, "CLOSE");
                });
                // This is ESP controller!
                ws.on('message', (data: string) => {
                    try {
                        const objData = JSON.parse(data);
                        const controller = this.dynamicControllers.get(ip);

                        // It might be hello message
                        if ('type' in objData && objData.type == 'hello') {
                            console.log(ip, "HELLO");

                            const hello = objData as Hello;
                            const mapIRs = new Map<string, {
                                lastRemote: number,
                                seq: string[],
                                handler?: IRKeysHandler,
                                wait: number,
                                timestamps: number[]
                            }>();

                            const clockController = new ClockController(ws, ip, hello, {
                                onDisconnect: () => {
                                    console.log(ip, 'DISCONNECT!!!');
                                    // console.trace();
                                    this.dynamicControllers.delete(ip);
                                    if (clockController.lcdInformer) {
                                        this.allInformers.delete(ip);
                                    }
                                    this.reloadAllWebClients('web');
                                    this.allInformers.runningLine('Отключено ' + clockController.name, 3000);
                                },
                                onWeatherChanged: (val) => {
                                    this.allInformers.additionalInfo(
                                        Array.prototype.concat(
                                            val.temp ? [util.tempAsString(val.temp)] : [],
                                            val.pressure ? ["давление " + util.toFixedPoint(val.pressure*0.00750062, 1) + "мм рт ст"] : [],
                                            val.humidity ? ["влажность " + util.toFixedPoint(val.humidity, 1) + "%"] : [],
                                            [this.nowWeather.get()]
                                        ).filter(x => !!x).join(', '));
                                },
                                onWeightChanged: (weight: number) => {
                                    this.allInformers.staticLine(weight + "г");
                                },
                                onWeightReset: () => {
                                    this.allInformers.staticLine("Сброс");
                                },
                                onPotentiometer: (value: number) => {                                   
                                    if (clockController.hasScreen()) {
                                        // Let's tune screen brightness
                                        // adc value is from 0 (nuke bright) to 1024 (absolutely dark)
                                        // 
                                        clockController.brightnessProperty.set(Math.floor((1024 - value) / 18));
                                    }
                                },
                                onIRKey: (remoteId: string, keyId: string) => {
                                    // console.log(remoteId, keyId);
                                    var _irState;
                                    if (!mapIRs.has(remoteId)) {
                                        _irState = { lastRemote: 0, seq: [], wait: 1500, timestamps: [] };
                                        mapIRs.set(remoteId, _irState);
                                    } else {
                                        _irState = mapIRs.get(remoteId);
                                    }

                                    const irState = _irState!;
                                    const now = new Date().getTime();

                                    irState.seq.push(keyId);
                                    irState.timestamps.push(now);
                                    var toHandle;
                                    for (const handler of this.irKeyHandlers) {
                                        const toWait = handler.partial(remoteId, irState.seq, false, irState.timestamps);
                                        if (toWait != null) {
                                            toHandle = handler;
                                            irState.wait = toWait;
                                        }
                                    }
                                    if (toHandle) {
                                        irState.handler = toHandle;
                                    } else {
                                        console.log('Ignored ' + irState.seq.join(",") + ' on ' + remoteId);
                                        irState.seq = [];
                                    }

                                    util.delay(irState.wait).then(() => {
                                        const now = new Date().getTime();
                                        if ((now - irState.lastRemote) >= irState.wait) {
                                            // Go!
                                            if (irState.handler && irState.handler.partial(remoteId, irState.seq, true, irState.timestamps) !== null) {
                                                irState.handler.complete(remoteId, irState.seq, irState.timestamps);
                                            }

                                            irState.seq = [];
                                            irState.lastRemote = now;
                                        }
                                    });

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
                                this.allInformers.set(ip, clockController.lcdInformer);
                            }
                            clockController.send({ type: "unixtime", value: Math.floor((new Date()).getTime() / 1000) });
                            if (clockController.hasScreen()) {
                                clockController.screenEnabledProperty.set(!this.isSleeping);
                            }

                            // this.allInformers.runningLine('Подключено ' + clockController.name, 3000);

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
            } else if (util.arraysAreEqual(url, ['web'])) {
                const lambda = this.allPropsFor.get(url[0]);
                let dispose: Disposable[] = [];
                if (lambda) {
                    lambda().then(allProps => {
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
                        console.log('received: %s', message);
                    }
                });

                ws.on('close', (message: string) => {
                    dispose.forEach(d => d.dispose());
                    dispose = [];
                });
            } else {
                console.log("WTH???", url);
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
                // console.log(names, namesDistinct);
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
                                    console.log(err);
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
                getYoutubeInfoById(ytb, (await this.keysSettings.read()).youtubeApiKey)
                    .then(resInfo => {
                        res.redirect(resInfo.thumbnailUrl);
                    })
                    .catch(e => console.error(e));
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
                res.send(util.wrapToHTML(["html", { lang: "en" }],
                    [
                        util.wrapToHTML("head", [
                            util.wrapToHTML(["meta", { 'http-equiv': "content-type", content: "text/html; charset=UTF-8" }]),
                            util.wrapToHTML(["meta", { name: "viewport", content: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" }], undefined),
                            util.wrapToHTML(["script", { type: "text/javascript" }],
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
                        util.wrapToHTML("body", [
                            util.wrapToHTML(["img", {
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
            res.send(await this.renderToHTML("web"));
        });
        router.get('/lights.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML("lights", (renderer, prop) => {
                return renderer.body(prop, {
                    bgColor: clrFromName(prop.name),
                    padding: "6px",
                    margin: "5px"
                });
            }));
        });
        router.get('/tv.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML("iptv"));
        });
        router.get('/settings.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML('settings'));
        });
        router.get('/actions.html', async (req, res) => {
            res.contentType('html');
            res.send(await this.renderToHTML('actions'));
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
                console.log('Parsed ' + channels.length + " IPTV channels");
                conf.channels = channels;
                conf.lastUpdate = new Date().getTime();
            });
        });
    }

    private async renderToHTML(idToReferesh: string, getBody: (renderer: HTMLRederer<any>, prop: Property<any>) => string = (renderer, prop) => renderer.body(prop)): Promise<string> {
        const allProps = await this.allPropsFor.get(idToReferesh)!();
        const propChangedMap = allProps.map((props, ctrlIndex) => {
            return props.map((prop: Property<any>, prIndex: number): string => {
                return `'${prop.id}' : (val) => { ${prop.htmlRenderer.updateCode(prop)} }`
            }).join(',\n');
        }).join(',\n');

        const hdr = [
            util.wrapToHTML(["meta", { 'http-equiv': "content-type", content: "text/html; charset=UTF-8" }]),
            util.wrapToHTML(["meta", { name: "viewport", content: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" }], undefined),
            util.wrapToHTML(["script", { type: "text/javascript" }],
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
        return util.wrapToHTML(["html", { lang: "en" }],
            util.wrapToHTML("head", hdr.join("\n")) + "\n" +
            util.wrapToHTML("body", allProps.map((ctrl) => {
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
            util.delay(1000).then(() => {
                const table = this.tablets.get(device.id);
                if (table) {
                    console.log('device - INIT', device);
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
        console.log("Playing " + JSON.stringify(c) + ' as ' + getType(c));

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
                const lines = util.splitLines(text);
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
                                console.log(prev);
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
        
        console.log('playSimpleUrl', url);
        t.playURL(url);
    }

    private rebootService(): void {
        util.runShell("/bin/systemctl", ["restart", "nodeserver"]);
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
                            const lines = util.splitLines(contents);
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