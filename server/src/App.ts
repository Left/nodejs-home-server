import * as express from 'express'
import * as http from 'http';
import * as WebSocket from 'ws';
// import * as stream from "stream";
import * as fs from "fs";
import * as path from "path";
import * as dgram from "dgram";
import * as crypto from 'crypto';
import * as querystring from 'querystring';

import * as curl from "./Curl";
import * as util from "./Util";
import { getYoutubeInfo } from "./Youtube";
import { Relay, Controller, newWritableProperty, CheckboxHTMLRenderer, SliderHTMLRenderer, Property, ClassWithId, SpanHTMLRenderer, Button, WritablePropertyImpl, SelectHTMLRenderer, isWriteableProperty, StringAndGoRendrer, ImgHTMLRenderer } from "./Props";
import { TabletHost, Tablet, adbClient, Tracker, Device } from "./Tablet";
import { CompositeLcdInformer } from './Informer';
import { ClockController, Hello, ClockControllerEvents } from './Esp8266';
// import { parse } from 'url';

class GPIORelay extends Relay {
    private _init: Promise<void>;
    private _modeWasSet: boolean = false;
    static readonly gpioCmd = "/root/WiringOP/gpio/gpio";

    constructor(readonly name: string, public readonly pin: number, private readonly conf: util.Config<{ relays: boolean[] }>, private readonly index: number) {
        super(name);

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
                    return this.conf.change(d => d.relays[this.index] = on);
                })
                .catch(err => console.log(err.errno));
        });
    }
}

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
            super("On/off");
        }

        public switch(on: boolean): Promise<void> {
            return this.pThis.config.change(conf => conf.on = on)
                .then(() => this.pThis.send([on ? 0x42 : 0x46, 0x00, 0x55])
                    .then(() => this.setInternal(on)));
        }
    })(this);

    public readonly allWhite = newWritableProperty<boolean>("All white", false, new CheckboxHTMLRenderer(),
        (val: boolean) => {
            this.config.change(conf => conf.allWhite = val).then(() => {
                if (val) {
                    this.send([0xC2, 0x00, 0x55]);
                } else {
                    this.send([0x40, (0xff * this.hue.get() / 100), 0x55]);
                }
            });
        });

    public readonly brightness = newWritableProperty<number>("Brightness", 50, new SliderHTMLRenderer(),
        (val: number) => {
            this.config.change(conf => conf.brightness = val).then(() => {
                this.send([0x4E, 0x2 + (0x15 * val / 100), 0x55]);
            });
        });

    public readonly hue = newWritableProperty<number>("Hue", 50, new SliderHTMLRenderer(),
        (val: number) => {
            this.config.change(conf => { conf.hue = val; conf.allWhite = false; }).then(() => {
                this.allWhite.set(false);
            });
        });

    readonly properties: Property<any>[] = [
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
    partial(arr: string[], final: boolean): number | null;
    /**
     * Accept the command
     */
    complete(arr: string[]): void;
}

type ChannelType = "Url" | "Ace";

interface Channel {
    type?: ChannelType;
    name: string;
    cat?: string;
    url: string;
    channel?: number;
}

function getType(c: Channel): ChannelType{
    return c.type || "Url"
}

function compareChannels(c1: Channel, c2: Channel): number {
    const t1 = getType(c1);
    const t2 = getType(c2);
    if (t1 !== t2) {
        return t1.localeCompare(t2);
    } else if (t1 === "Url") {
        return c1.url.localeCompare(c2.url);
    } else if (t1 === "Ace") {
        return c1.name.localeCompare(c2.name);
    }
    return 0; // Should never happen
}

interface AceChannel {
    name: string;
    cat: string;
    url: string;
}

type TimerProp = { val: Date | null, controller: Controller, fireInSeconds: (sec: number) => void };


interface StartPlayingResponce {
    event_url: string,
    stat_url: string,
    playback_session_id: string,
    is_live: number,
    playback_url: string,
    is_encrypted: number,
    command_url: string,
    infohash: string 
}

interface StatusResponce { 
    status: string,
    uploaded: number,
    speed_down: number,
    speed_up: number,
    downloaded: number,
    playback_session_id: string,
    time: number,
    peers: number,
    total_progress: number,
    is_encrypted: number,
    disk_cache_stats: { 
        avail: number,
        disk_cache_limit: number,
        inactive_inuse: number,
        active_inuse: number 
    },
    is_live: number,
    progress: number,
    infohash: string,
    selected_stream_index: number,
    selected_file_index: number 
}

class AceServerInfo {
    public resp?: StartPlayingResponce;

    constructor(public aceId: string) {
    }
}

class App implements TabletHost {
    public expressApi: express.Express;
    public server: http.Server;
    public readonly wss: WebSocket.Server;
    public currentTemp?: number;

    public static readonly acestreamHost = "192.168.121.38:6878";

    private gpioRelays = util.newConfig({ relays: [false, false, false, false] }, "relays");

    private r1 = new GPIORelay("Лампа на шкафу", 38, this.gpioRelays, 0);
    private r2 = new GPIORelay("Колонки", 40, this.gpioRelays, 1);
    private r3 = new GPIORelay("Коридор", 36, this.gpioRelays, 2);
    private r4 = new GPIORelay("Потолок", 32, this.gpioRelays, 3);

    private allowRenames = false;

    private ctrlGPIO = {
        name: "Комната",
        properties: [this.r1, this.r2, this.r3, this.r4]
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

    private readonly kindle: Tablet = new Tablet('192.168.121.166:5556', 'Kindle', this, true);
    private readonly nexus7: Tablet = new Tablet('00eaadb6', 'Nexus', this, false);
    private readonly nexus7TCP: Tablet = new Tablet('192.168.121.172:5555', 'Nexus TCP', this, true);

    private readonly tablets: Map<string, Tablet> = new Map(
        [this.kindle, this.nexus7, this.nexus7TCP].map(t => [t.id, t] as [string, Tablet])
    );

    private timeProp(name: string, upto: number, onChange: (v: number) => void): WritablePropertyImpl<number> {
        return newWritableProperty<number>(
            name,
            0,
            new SelectHTMLRenderer<number>(Array.from({ length: upto }, ((v, k) => k)), i => "" + i),
            (v: number) => { onChange(v); });
    }

    private createTimer(name: string, 
        confName: string, 
        onFired: ((d: Date) => void)): TimerProp {
        interface Conf {
            val: string | null;
        }

        const conf = util.newConfig({ val: null } as Conf, confName);
        conf.read().then(conf => {
            setNewValue(conf.val ? new Date(conf.val) : null);
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
            (_n: number) => {
                const n = timerIn[_n];
                if (n.startsWith("val")) {
                    that.fireInSeconds(+n.slice(3));
                } else if (n === "never") {
                    setNewValue(null);
                } else if (n === "atdate") {
                    onDateChanged();
                }
            });
        var timers: NodeJS.Timer[] = [];

        const setNewValue = (d: Date | null) => {
            console.log(name + " --> " + d);
            if (d !== that.val) {
                // that.val === undefined || that.val.getTime() != d.getTime())) {
                timers.forEach(t => clearTimeout(t));
                timers = [];

                setInterval(() => {
                    if (that.val) {
                        inProp.setInternal(Math.floor((that.val.getTime() - Date.now())/1000));
                    } else {
                        inProp.setInternal(undefined);
                    }
                }, 1000);    

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
                        onFired(tt);
                        setNewValue(null);
                    }, msBefore));
                    [45, 30, 20, 15, 10, 5, 4, 3, 2, 1].forEach(m => {
                        const msB = msBefore - m*60*1000;
                        if (msB > 0) {
                            timers.push(setTimeout(() => {
                                // 
                                console.log(m + ' минут до ' + name);
                                this.allInformers.runningLine(m + ' минут до ' + name.toLowerCase());
                            }, msB));
                        }
                    });
                    conf.change(t => t.val = that.val!.toJSON());
                } else {
                    // Dropped timer
                    // hourProp.setInternal(0);
                    // minProp.setInternal(null);
                    // secProp.setInternal(null);
                    hourProp.setInternal(0);
                    minProp.setInternal(0);
                    secProp.setInternal(0);
                    orBeforeProp.setInternal(0);
                    conf.change(t => t.val = null);
                }
            }
        }


        const that = {
            val: null as Date | null,
            controller: {
                name: name,
                properties: [
                    hourProp, minProp, secProp, orBeforeProp, inProp
                ]
            },
            fireInSeconds: (sec: number) => {
                const d = new Date();
                d.setTime(d.getTime() + sec * 1000);
                setNewValue(d);
            }
        };
        return that;
    }

    private initController(ct: Controller): void {
        ct.properties.forEach(prop => {
            prop.onChange(() => {
                this.broadcastToWebClients({
                    type: "onPropChanged",
                    id: prop.id,
                    name: prop.name,
                    val: prop.htmlRenderer.toHtmlVal(prop.get())
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

    public sleepAt = this.createTimer("Выкл", "off", async d => {
        console.log("SLEEP", d);
        //this.kindle.screenIsOn.set(false);
        const wasOnIds = [];
        for (const ctrl of this.controllers) {
            for (const prop of ctrl.properties) {
                if (prop instanceof Relay) {
                    if (prop.get()) {
                        wasOnIds.push(prop.id);
                    }
                    prop.set(false);
                }
            }
        }
        const clock = this.findDynController('ClockNRemote');
        if (clock) {
            clock.brightnessProperty.set(5);
            await util.delay(500);
            clock.screenEnabledProperty.set(false);
        }

        this.relaysState.wasOnIds = wasOnIds;
    });

    public timer = this.createTimer("Таймер", "timer", d => {
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

        blinkMiLight();
    });

    public wakeAt = this.createTimer("Вкл", "on", d => {
        console.log("WAKE", d);
        //this.nexus7.screenIsOn.set(true);
        // for (const wo of this.relaysState.wasOnIds) {
        //     (ClassWithId.byId(wo) as Relay).set(true);
        // }
        const wake = async () => {
            this.allInformers.runningLine("Просыпаемся...");

            await util.delay(2000);
            this.miLight.brightness.set(10);
            await util.delay(100);
            this.miLight.allWhite.set(true);
            await util.delay(100);
            this.miLight.switchOn.set(true);

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
                kr.relays[1].switch(true);
            }

            const clock = this.findDynController('ClockNRemote');
            if (clock) {
                clock.brightnessProperty.set(20);
                clock.screenEnabledProperty.set(true);
            } 

            await util.delay(3000);
            this.r1.switch(true);

            this.miLight.brightness.set(80);
        }
        wake();
    });

    private nowDecodedByAce = newWritableProperty<string>("", "", new SpanHTMLRenderer());
    private statusString = newWritableProperty<string>("", "", new SpanHTMLRenderer());
    private aceHostAlive = newWritableProperty<boolean>("", false, new SpanHTMLRenderer(v => v ? "Сервер включен" : "Сервер выключен"));

    private ctrlAceDecoder = {
        name: "AceStream",
        properties: [
            this.aceHostAlive,
            this.nowDecodedByAce,
            this.statusString
        ]
    };

    
    private aceInfo?: AceServerInfo;

    private ctrlControlOther = {
        name: "Другое",
        properties: [
            Button.create("Reboot server", () => {
                util.runShell("/bin/systemctl", ["restart", "nodeserver"])
            }),
            Button.create("Reboot AceStream", () => {
                const go = async () => {
                    console.log('Before reboot');
                    const dockerPs = await util.runShell("/usr/bin/docker", ["ps"]);
                    const line = util.splitLines(dockerPs).find(s => !!s.match(/left76\/ace:vadim-acestream/gi));
                    console.log("Got line", line);
                    if (line) {
                        const containerId = line.split(' ')[0];
                        console.log("Got id", containerId);
                        await util.runShell("/usr/bin/docker", ["restart", containerId]);
                    }   
                    await util.delay(1000);
                };
                
                go();
            }),
            Button.create("Reboot Orange Pi", () => util.runShell("reboot", [])),
            Button.createClientRedirect("TV Channels", "/tv.html"),
            Button.createClientRedirect("AceStream Channels", "/torrent_tv.html"),
            newWritableProperty<boolean>("Allow renames", this.allowRenames, new CheckboxHTMLRenderer(), (val: boolean) => {
                this.allowRenames = val;
                this.reloadAllWebClients();
            })
        ]
    }

    // We're using dockerized acestream from https://github.com/lucabelluccini/acestream-engine-armv7-docker
    private acestreamHistoryConf = util.newConfig({ channels: [] as Channel[], lastUpdate: 0 }, "acestream_tv_channels");
    private tvChannels = util.newConfig({ channels: [] as Channel[], lastUpdate: 0 }, "m3u_tv_channels");
    private channelsHistoryConf = util.newConfig({ channels: [] as Channel[] }, "tv_channels");

    private channelAsController(h: Channel, 
        additionalPropsBefore: Property<any>[] = [],
        additionalPropsAfter: Property<any>[] = []): Controller {
        const that = this;
        return new (class Channels implements Controller {
            public readonly name = "";
            public readonly online = true; // Always online
            public get properties(): Property<any>[] {
                return Array.prototype.concat(
                    additionalPropsBefore,
                    newWritableProperty<string>("", "get_tv_logo?name=" + encodeURIComponent(h.name), new ImgHTMLRenderer(30, 30)),
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
        return this.channelsHistoryConf.last().channels.map((h, index) => {
            // If needed, add own channel
            const channels = Array.prototype.concat(h.channel ? [h.channel] : [], channelsProto) as number[];
            // Sort!
            // channels.sort((i1, i2) => i1 == i2 ? 0 : (i1 < i2 ? -1 : 1));
            
            return this.channelAsController(h, 
                [
                    newWritableProperty<number>("", (h.channel || -1),
                        new SelectHTMLRenderer<number>(channels, _n => "" + _n),
                            (num) => {
                                this.channelsHistoryConf.change(hist => {
                                    h.channel = num;
                                })
                            })
                ],
                Array.prototype.concat(h.channel ? [] : [
                    Button.create("Remove", () => {
                        this.channelsHistoryConf.change(hist => {
                            if (!hist.channels[index].channel) {
                                hist.channels.splice(index, 1);
                            }
                        }).then(() => {
                            this.reloadAllWebClients();
                        });
                    }),
                ],
                (this.allowRenames) ? [
                    newWritableProperty("New name", h.name, new StringAndGoRendrer("Rename"), (val) => {
                        this.channelsHistoryConf.change(hist => {
                            h.name = val;
                        }).then(() => this.reloadAllWebClients());
                    }),
                ] : []));
        });
    }

    private reloadAllWebClients() {
        this.broadcastToWebClients({ type: "reloadProps" });
    }

    private toAceUrl(aceCode: string): string {
        return "http://192.168.121.38:6878/ace/getstream?id=" + aceCode +"&hlc=1&spv=0&transcode_audio=0&transcode_mp3=0&transcode_ac3=0&preferred_audio_language=ru";
    }

    private get controllers(): Controller[] {
        const dynPropsArray = Array.from(this.dynamicControllers.values());
        dynPropsArray.sort((a, b) => a.ip == b.ip ? 0 : (a.ip < b.ip ? -1 : 1));

        // console.log("Ace channels: ", this.acestreamHistoryConf.last().channels.length);

        return Array.prototype.concat([
                this.sleepAt.controller,
                this.wakeAt.controller,
                this.timer.controller,
                this.ctrlControlOther,
                this.ctrlAceDecoder,
                this.miLight,
            ],
            GPIORelay.gpioInstalled() ? [ this.ctrlGPIO ] : [],
            this.allOnlineTablets(),
            dynPropsArray,
            this.renderChannels()
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

    private createPowerOnOffTimerKeys(prefix: string, actions: () => { showName: string, valueName?: string, action: (dd: number) => void }[]): IRKeysHandler {
        return {
            partial: arr => {
                const firstNonPref = util.getFirstNonPrefixIndex(arr, prefix)
                if (firstNonPref == 0 || arr.slice(firstNonPref).some(x => !util.isNumKey(x))) {
                    return null; // Not our beast
                }

                const actionsa = actions();
                const a = actionsa[(firstNonPref - 1) % actionsa.length];
                if (firstNonPref == arr.length) {
                    // No numbers yet
                    this.allInformers.staticLine(a.showName);
                    return 3000;
                } else {
                    // Numbers are here
                    this.allInformers.staticLine(util.numArrToVal(arr.slice(firstNonPref)) + (a.valueName || ""));
                    return 2000;
                }
            },
            complete: arr => {
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
            this.allInformers.runningLine(name + " в " + util.toHMS(timer.val!)) );
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
                        this.allInformers.runningLine("Канал " + dd + " не найден");
                    }
                }
            })).slice());
    }

    private makeUpDownKeys(keys: {key: string, action: () => void}[]): IRKeysHandler {
        return {
            partial: (arr, final) => {
                const allAreVolControls = arr.length > 0 && arr.every(k => keys.some(kk => kk.key === k));
                if (allAreVolControls) {
                    if (!final) {
                        const last = arr[arr.length - 1];
                        const kk = keys.find(kk => last === kk.key);
                        if (kk) {
                            kk.action()
                        }
                    }

                    return 2500;
                } else {
                    return null; // We didn't recognize the command
                }

            },
            complete: arr => {
                // console.log("Nothing to do");
            }
        } as IRKeysHandler;
    }

    private dayBeginsTimer: util.Disposable = util.emptyDisposable;
    private dayEndsTimer: util.Disposable = util.emptyDisposable;

    private dayBegins() {
        const clock = this.findDynController('ClockNRemote');
        if (clock) {
            clock.screenEnabledProperty.set(true);
            clock.brightnessProperty.set(40);
            if (clock.lcdInformer) {
                clock.lcdInformer.runningLine("Рассвет");
            }
        }
        this.miLight.brightness.set(50);
    }

    private dayEnds() {
        const clock = this.findDynController('ClockNRemote');
        if (clock) {
            clock.brightnessProperty.set(40);
            if (clock.lcdInformer) {
                clock.lcdInformer.runningLine("Закат");
            }
        }
        this.miLight.brightness.set(100);
    }

    private irKeyHandlers: IRKeysHandler[] = [
        this.createPowerOnOffTimerKeys('power', () => [
            { showName: "Выкл", valueName: "мин", action: (dd) => this.timerIn(dd * 60, "Выключение", this.sleepAt) },
            { showName: "Вкл", valueName: "мин", action: (dd) => this.timerIn(dd * 60, "Включение", this.wakeAt) },
            { showName: "Таймер", valueName: "мин", action: (dd) => this.timerIn(dd * 60, "Таймер", this.timer) }
        ]),
        this.makeSwitchChannelIrSeq('ent'),
        this.makeSwitchChannelIrSeq('reset'),
        this.simpleCmd([['fullscreen']], "MiLight", () => {
            this.miLight.switchOn.switch(!this.miLight.switchOn.get());
        }),
        this.simpleCmd([["record"]], "Лампа на шкафу", () => {
            this.r1.switch(!this.r1.get());
        }),
        this.simpleCmd([[]], "Колонки", () => {
            this.r2.switch(!this.r2.get());
        }),
        this.simpleCmd([['stop']], "Коридор", () => {
            this.r3.switch(!this.r3.get());
        }),
        this.simpleCmd([['time_shift']], "Потолок", () => {
            this.r4.switch(!this.r4.get());
        }),
        this.simpleCmd([['av_source'], ['mts']], "Потолок на кухне", () => {
            this.toggleRelay('KitchenRelay', 0);
        }),
        this.simpleCmd([['clear'], ['min']], "Лента на кухне", () => {
            this.toggleRelay('KitchenRelay', 1);
        }),
        // Sound controls
        this.makeUpDownKeys([
            { key: 'volume_up', action: () => this.kindle.volume.set(this.kindle.volume.get() + 100 / 15)},
            { key: 'volume_down', action: () => this.kindle.volume.set(this.kindle.volume.get() - 100 / 15)}
        ]),
        // Channel controls
        this.makeUpDownKeys([
            { key: 'channel_up', action: () => this.playChannel(this.kindle, this.nextChannel(this.kindle, 1))},
            { key: 'channel_down', action: () => this.playChannel(this.kindle, this.nextChannel(this.kindle, -1))}
        ])
    ];

    private nextChannel(tbl: Tablet, add: number): Channel {
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

    constructor() {
        this.channelsHistoryConf.read();

        // Load acestream channels
        this.acestreamHistoryConf.read().then(conf => {
            if ((new Date().getTime() - conf.lastUpdate) > 15*60*1000) {
                this.reloadAceStream();
            }
            console.log("Read " + conf.channels.length + " ACE channels");
        });

        // Load TV channels from different m3u lists
        this.tvChannels.read().then(conf => {
            if ((new Date().getTime() - conf.lastUpdate) / 1000 > 60*60) {
                this.reloadM3uPlaylists();
            }
            console.log("Read " + conf.channels.length + " M3U channels");
        });

        const getSunrizeSunset = () => {
            const now = new Date();
            const lat = 44.9704778;
            const lng = 34.1187681;
            console.log('sunrise query');
            curl.get(`https://api.sunrise-sunset.org/json?formatted=0&lat=${lat}&lng=${lng}&date=${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`)
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
            this.reloadAceStream();
            this.reloadM3uPlaylists();
        }, 1000*60*60);

        const checkAceHost = async () => {
            try {
                const str = await curl.get("http://" + App.acestreamHost + "/webui/api/service?method=get_version&format=json");
                const parsed = JSON.parse(str);
                this.aceHostAlive.setInternal(parsed.error == null);
            } catch (e) {
                this.aceHostAlive.setInternal(false);
            }
            await util.delay(2000);
            checkAceHost();
        }
        checkAceHost();

        this.expressApi = express();

        this.server = http.createServer(this.expressApi);

        this.wss = new WebSocket.Server({ server: this.server });
        this.wss.on('connection', (ws: WebSocket, request) => {
            const url = (request.url || '/').split('/').filter(p => !!p);
            // console.log("Connection from", request.connection.remoteAddress, request.url);
            const remoteAddress = request.connection.remoteAddress;
            const ip = util.parseOr(remoteAddress, /::ffff:(.*)/, remoteAddress);

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
                                wait: number
                            }>();

                            const clockController = new ClockController(ws, ip, hello, {
                                onDisconnect: () => {
                                    console.log(ip, 'DISCONNECT!!!');
                                    // console.trace();
                                    this.dynamicControllers.delete(ip);
                                    if (clockController.lcdInformer) {
                                        this.allInformers.delete(ip);
                                    }
                                    this.reloadAllWebClients();
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
                                            const toWait = handler.partial(irState.seq, false);
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
                                                if (irState.handler && irState.handler.partial(irState.seq, true) !== null) {
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
                                this.allInformers.set(ip, clockController.lcdInformer);
                            }
                            this.initController(clockController);
                            clockController.send({ type: "unixtime", value: Math.floor((new Date()).getTime() / 1000) });

                            // this.allInformers.runningLine('Подключено ' + clockController.name);

                            // Reload
                            this.reloadAllWebClients();

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
                            props: ct.properties.map(prop => ({ 
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
                    // console.log('closed web client');
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
        router.get('/get_tv_logo', (req, res) => {
            const n = req.query['name'];
            fs.readFile(path.normalize(__dirname + '/../web/logos/' + n + '.png'),
                (err, buf) => {
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
                });
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
        router.get('/index.html', (req, res) => {
            res.contentType('html');
            res.send(this.renderToHTML(
                this.controllers.map((ctrl) => {
                    return Array.prototype.concat(
                        ctrl.name ? [ newWritableProperty("", ctrl.name, new SpanHTMLRenderer()) ] : [], 
                        ctrl.properties);
                })
            ));
        });
        router.get('/torrent_tv.html', (req, res) => {
            res.contentType('html');
            res.send(this.renderToHTML(
                this.acestreamHistoryConf.last().channels
                    .filter(h => h.cat 
                        && !h.cat.match(/18(_?)plus/) 
                        && !h.name.match(/Nuart/gi)
                        && !h.name.match(/Visit-X/gi))
                    .map((h, index) => {
                    return Array.prototype.concat(
                        [ newWritableProperty("", "" + index + ".", new SpanHTMLRenderer()) ], 
                        newWritableProperty<string>("", "get_tv_logo?name=" + encodeURIComponent(h.name), new ImgHTMLRenderer(30, 30)),
                        [ newWritableProperty("", h.name, new SpanHTMLRenderer()) ],
                        this.makePlayButtonsForChannel(h.url, 
                            (t) => {
                                this.playAce(t, h);
                                // that.playURL(t, h.url, h.name)
                            })
                    );
                })
            ));
        });
        router.get('/tv.html', (req, res) => {
            res.contentType('html');
            res.send(this.renderToHTML(
                this.tvChannels.last().channels.map((h, index) => {
                    return Array.prototype.concat(
                        [ newWritableProperty("", "" + index + ".", new SpanHTMLRenderer()) ], 
                        [ newWritableProperty("", h.name, new SpanHTMLRenderer()) ],
                        this.makePlayButtonsForChannel(h.url, t => this.playURL(t, h.url, name))
                    );
                })
            ));
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

        // Subscribe to all the props changes
        this.controllers.forEach(ct => {
            this.initController(ct);
        });

        Array.from(this.tablets.values()).forEach(tablet => {
            if (tablet.isTcp) {
                // console.log('Tablet', tablet.id);
                tablet.connectIfNeeded();
            }
        });
    }

    private reloadM3uPlaylists() {
        this.parseM3Us([
            "http://iptviptv.do.am/_ld/0/1_IPTV.m3u",
            "http://tritel.net.ru/cp/files/Tritel-IPTV.m3u",
            "http://getsapp.ru/IPTV/Auto_IPTV.m3u",
            "https://webarmen.com/my/iptv/auto.nogrp.m3u",
            "https://smarttvnews.ru/apps/Channels.m3u"
        ]).then(channels => {
            this.tvChannels.change(conf => {
                conf.channels = channels;
                conf.lastUpdate = new Date().getTime();
            });
        });
    }

    private reloadAceStream() {
        curl.get("http://pomoyka.win/trash/ttv-list/as.json")
            .then(text => {
                const aceChannels = JSON.parse(text).channels as AceChannel[];
                console.log("Downloaded " + aceChannels.length + " channels");
                this.acestreamHistoryConf.change(conf => {
                    conf.channels = aceChannels;
                    conf.lastUpdate = new Date().getTime();
                });
            })
            .catch(e => console.log(e));
    }

    private renderToHTML(allProps: Property<any>[][]): string {
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

                    res = prop.htmlRenderer.body(prop);

                    return res;
                }).join("&nbsp;\n") + "</div>";
            }).join("\n"))
        );
    }

    private processDevice(device: Device): void {
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

    public nameFromUrl(url: string): Promise<string> {
        return this.channelsHistoryConf.read()
            .then(c => {
                const f = c.channels.find(x => x.url === url && x.name != x.url);
                if (f) {
                    return Promise.resolve(f.name);
                }
                const f2 = this.tvChannels.last().channels.find(x => x.url === url && x.name != x.url);
                if (f2) {
                    return Promise.resolve(f2.name + " (TV)");
                }
                const f3 = this.acestreamHistoryConf.last().channels.find(x => url === this.toAceUrl(x.url));
                if (f3) {
                    return Promise.resolve(f3.name + " (Torrent)");
                }
                
                return getYoutubeInfo(url)
                    .then(u => u.title + " (Youtube)");
            });
    }

    public playChannel(t: Tablet, c: Channel): Promise<void> {
        console.log("Playing " + JSON.stringify(c));
        if (c.type == 'Ace') {
            return this.playAce(t, c);
        } else {
            return this.playURL(t, c.url, c.name);
        }
    }

    public async playURL(t: Tablet, _url: string, _name: string): Promise<void> {
        const url = _url.trim();
        const gotName = (name: string) => {
            // update history
            this.justStartedToPlayChannel({
                url, 
                name
            });
        };
        if (!_name) {
            Promise.race([
                this.nameFromUrl(url).catch(() => url),
                util.delay(5000).then(() => url)
            ]).then(gotName);
        } else {
            gotName(_name);
        }

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
                if (c.type === "Ace") {
                    c.url = ch.url; // Update ACE URL
                }
                hist.channels.splice(index, 1);
                hist.channels.splice(0, 0, c);
            }
        }).then(() => {
            this.reloadAllWebClients();
        });
        ;
    }

    private parseM3Us(urls: string[]): Promise<Channel[]> {
        return Promise.all(urls.map(_url => {
            return curl.get(_url).then(text => {
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
                        } else if (val) {
                            prev.url = val;
                            if (!prev.name) {
                                console.log(prev);
                            }
                            res.push(prev);
                            return {} as Channel;
                        }
                        return prev;
                    }, {} as Channel);

                    return res as Channel[];
                } else {
                    throw new Error('Invalid format');
                }
            });
        })).then(arr => {
            const res = Array.prototype.concat(...arr);
            res.sort((a, b) => a.name.localeCompare(b.name));
            // console.log(res);
            return res;
        });
    }
  
    public async playAce(t: Tablet, c: Channel): Promise<void> {
        const newFromHistory = this.acestreamHistoryConf.last().channels.find(c2 => c.name.localeCompare(c2.name) === 0);
        if (newFromHistory && newFromHistory.url != c.url) {
            c.url = newFromHistory.url;
            console.log("Got new AceHash", c.url, newFromHistory.name, newFromHistory.cat);
        } else {
            console.log("Not found in history");
        }

        if (this.aceInfo) {
            if (this.aceInfo.aceId === c.url && this.aceInfo.resp && this.aceInfo.resp.playback_url) {
                // We're already playing this url
                this.playSimpleUrl(t, this.aceInfo.resp.playback_url, c.name);
                return;
            }

            if (this.aceInfo.resp && this.aceInfo.resp.command_url) {
                // There is a control URL, so we're already playing. let's stop
                curl.get(this.aceInfo.resp.command_url + "?method=stop");
            }
        }

        this.aceInfo = new AceServerInfo(c.url);
        this.nowDecodedByAce.setInternal(c.name);
        this.allInformers.runningLine("Загружаем " + c.name + "...");
        const res = await curl.get("http://" + App.acestreamHost + 
            "/hls/manifest.m3u8?" +
                [
                    "id=" + c.url, 
                    "format=json", 
                    "use_api_events=1",
                    "use_stop_notifications=1",
                    "hlc=1",
                    "spv=0",
                    "transcode_audio=0",
                    "transcode_mp3=0",
                    "transcode_ac3=0",
                    "preferred_audio_language=ru"
                ].join("&"));
        const reso = JSON.parse(res);
        let sessionStopped = false;
        let playing = false;
        if (!reso.error) {
            console.log(c.url, c.name, reso.response);
            const resolvedAt = new Date();
            this.aceInfo.resp = reso.response;
            // if (reso.response.is_live != 1) {
            //     this.allInformers.runningLine(name + " не транслируется");
            //     return;
            // }

            const eventsPoll = async () => {
                const ev = await curl.get(reso.response.event_url);
                const evo = JSON.parse(ev);
                console.log(c.name, evo);
                if (evo.error === 'unknown playback session id') {
                    sessionStopped = true;
                }
                if (!sessionStopped) {
                    eventsPoll();
                }
            }
            eventsPoll();

            const statsPoll = async () => {
                const ev = await curl.get(reso.response.stat_url);
                if (!sessionStopped) {
                    const evo = JSON.parse(ev);
                    if (!evo.error) {
                        const resp = evo.response as StatusResponce;

                        this.statusString.setInternal([
                            "Status:", resp.status,
                            "Downloaded:", util.kbmbgb(resp.downloaded),
                            "Download speed:", util.kbmbgb(resp.speed_down*1000) + "/sec",
                            "Peers:", resp.peers
                        ].join(" "));
                    
                        const timePassed = (new Date()).getTime() - resolvedAt.getTime();
                        if (!playing) {
                            // Wait while 2Mb of data is loaded and then start playback
                            if (resp.downloaded > 2000000 || (resp.peers >= 1 && timePassed > 3000)) {
                                playing = true;
                                // this.allInformers.runningLine("Включаем " + c.name + "...");
                                this.playSimpleUrl(t, reso.response.playback_url, c.name);
                                this.justStartedToPlayChannel(c);
                            }
                        }
                    }

                    await util.delay(500);
                    statsPoll();
                }
            }
            statsPoll();
        } else {
            this.allInformers.runningLine("Ошибка загрузки " + c.name + ": " + reso.error);
            throw new Error(reso.error);
        }
        // 
        // console.log("wanna play ", h.url);

    }

    public async playSimpleUrl(t: Tablet, url: string, name: string) {
        if (!t.screenIsOn.get()) {
            await t.screenIsOn.set(true);
        }

        this.r2.switch(true);

        this.allInformers.runningLine("Включаем " + name + " на " + t.shortName);
        
        t.playURL(url);
    }
}

process.on('uncaughtException', (err: Error) => {
    console.error(err.stack);
    console.log("Node NOT Exiting...");
});

process.on('unhandledRejection', (reason: Error | any, p: Promise<any>) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    // application specific logging, throwing an error, or other logic here
});

export default new App()