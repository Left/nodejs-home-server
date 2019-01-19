import * as express from 'express'
import * as http from 'http';
import * as WebSocket from 'ws';
// import * as stream from "stream";
import * as fs from "fs";
// import * as os from "os";
import * as dgram from "dgram";
import * as crypto from 'crypto';

import * as curl from "./Curl";
import * as util from "./Util";
import { getYoutubeInfo } from "./Youtube";
import { Relay, Controller, newWritableProperty, CheckboxHTMLRenderer, SliderHTMLRenderer, Property, ClassWithId, SpanHTMLRenderer, Button, WritablePropertyImpl, SelectHTMLRenderer, isWriteableProperty, PropertyImpl, StringAndGoRendrer } from "./Props";
import { TabletHost, Tablet, adbClient, Tracker, Device } from "./Tablet";
import { CompositeLcdInformer } from './Informer';
import { ClockController, Hello, ClockControllerEvents } from './Esp8266';

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

interface Channel {
    name: string;
    cat: string;
    url: string;
    channel?: number;
}

interface AceChannel {
    name: string;
    cat: string;
    url: string;
}

type TimerProp = { val: Date | null, controller: Controller, fireInSeconds: (sec: number) => void };

class App implements TabletHost {
    public expressApi: express.Express;
    public server: http.Server;
    public readonly wss: WebSocket.Server;
    public currentTemp?: number;

    private gpioRelays = util.newConfig({ relays: [false, false, false, false] }, "relays");

    private r1 = new GPIORelay("Лампа на шкафу", 38, this.gpioRelays, 0);
    private r2 = new GPIORelay("Колонки", 40, this.gpioRelays, 1);
    private r3 = new GPIORelay("Коридор", 36, this.gpioRelays, 2);
    private r4 = new GPIORelay("Потолок", 32, this.gpioRelays, 3);

    private allowRenames = false;

    private ctrlGPIO = {
        name: "Комната",
        online: GPIORelay.gpioInstalled(), // 
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

    private readonly tablets: Map<string, Tablet> = new Map(
        [this.kindle, this.nexus7].map(t => [t.id, t] as [string, Tablet])
    );

    private timeProp(name: string, upto: number, onChange: (v: number) => void): WritablePropertyImpl<number> {
        return newWritableProperty<number>(
            name,
            0,
            new SelectHTMLRenderer<number>(Array.from({ length: upto }, ((v, k) => k)), i => "" + i),
            (v: number) => { onChange(v); });
    }

    private createTimer(name: string, confName: string, onFired: ((d: Date) => void)): TimerProp {
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
        var timer: NodeJS.Timer;

        const setNewValue = (d: Date | null) => {
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
                online: true, // Always online
                properties: [
                    hourProp, minProp, secProp, orBeforeProp
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

    public sleepAt = this.createTimer("Выкл", "off", d => {
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
        for (const wo of this.relaysState.wasOnIds) {
            (ClassWithId.byId(wo) as Relay).set(true);
        }
        // this.miLight.brightness.set(50);
    });

    private ctrlControlOther = {
        name: "Другое",
        online: true, // Always online
        properties: [
            Button.create("Reboot server", () => util.runShell("/bin/systemctl restart nodeserver", [])),
            Button.create("Reboot Orange Pi", () => util.runShell("reboot", [])),
            Button.createClientRedirect("TV Channels", "/tv.html"),
            Button.createClientRedirect("AceStream Channels", "/torrent_tv.html"),
            newWritableProperty<boolean>("Allow renames", this.allowRenames, new CheckboxHTMLRenderer(), (val: boolean) => {
                this.allowRenames = val;
                this.reloadAllWebClients();
            }),
            // newWritableProperty("Switch devices to server", "192.168.121.38", new StringAndGoRendrer("Go"), (val: string) => {
            //     for (const ctrl of this.dynamicControllers.values()) {
            //         ctrl.send({ type: 'setProp', prop: 'websocket.server', value: val });
            //         ctrl.send({ type: 'setProp', prop: 'websocket.port', value: '8080' });
            //         util.delay(1000).then(() => ctrl.reboot());
            //     }
            //     console.log('Switch all devices to other server');
            // })
        ]
    }

    private get onlineControllers(): Controller[] {
        return this.controllers.filter(c => c.online);
    }

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
                    newWritableProperty<string>("", h.name, new SpanHTMLRenderer()),
                    that.makePlayButtonsForChannel(h.url, h.name), 
                    additionalPropsAfter);
            }
        })();
    }

    private makePlayButtonsForChannel(url: string, name: string): Button[] {
        return Array.from(this.tablets.values()).map(t => Button.create("Play [ " + t.shortName + " ]", () => this.playURL(t, url, name)));
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
                Array.prototype.concat([
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
        return "http://192.168.121.38:6878/ace/getstream?id=" + aceCode +"&hlc=1&spv=0&transcode_audio=0&transcode_mp3=0&transcode_ac3=0&preferred_audio_language=eng";
    }

    private get controllers(): Controller[] {
        const dynPropsArray = Array.from(this.dynamicControllers.values());
        dynPropsArray.sort((a, b) => a.id == b.id ? 0 : (a.id < b.id ? -1 : 1));

        // console.log("Ace channels: ", this.acestreamHistoryConf.last().channels.length);

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

    private createPowerOnOffTimerKeys(prefix: string, actions: { showName: string, valueName?: string, action: (dd: number) => void }[]): IRKeysHandler {
        return {
            partial: arr => {
                const firstNonPref = util.getFirstNonPrefixIndex(arr, prefix)
                if (firstNonPref == 0 || arr.slice(firstNonPref).some(x => !util.isNumKey(x))) {
                    return null; // Not our beast
                }


                const a = actions[(firstNonPref - 1) % actions.length];
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
                    actions[(firstNonPref - 1) % actions.length].action(dd);
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

    private irKeyHandlers: IRKeysHandler[] = [
        this.createPowerOnOffTimerKeys('power', [
            { showName: "Выкл", valueName: "мин", action: (dd) => this.timerIn(dd * 60, "Выключение", this.sleepAt) },
            { showName: "Вкл", valueName: "мин", action: (dd) => this.timerIn(dd * 60, "Включение", this.wakeAt) },
            { showName: "Таймер", valueName: "мин", action: (dd) => this.timerIn(dd * 60, "Таймер", this.timer) }
        ]),
        this.createPowerOnOffTimerKeys('ent', Array.from(this.tablets.values()).map(t => {
            return {
                showName: t.shortName, action: (dd: number) => {
                    const chan = this.channelsHistoryConf.last().channels.find(c => c.channel == dd);
                    if (chan) {
                        if (!t.screenIsOn.get()) {
                            t.screenIsOn.set(true);
                        }
                        t.stopPlaying()
                            .then(() => {
                                this.playURL(t, chan.url, chan.name);
                            });
                    } else {
                        this.allInformers.runningLine("Канал " + dd + " не найден");
                    }
                }
            };
        }
        )),
        this.simpleCmd([['fullscreen']], "MiLight", () => {
            this.miLight.switchOn.switch(!this.miLight.switchOn.get());
        }),
        this.simpleCmd([["record"]], "Лампа на шкафу", () => {
            this.r1.switch(!this.r1.get());
        }),
        this.simpleCmd([['n0', 'n2']], "Колонки", () => {
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
        (() => {
            return {
                partial: (arr, final) => {
                    const allAreKeyControls = arr.length > 0 && arr.every(k => k === 'volume_up' || k === 'volume_down');
                    if (allAreKeyControls) {
                        if (!final) {
                            const last = arr[arr.length - 1];

                            this.kindle.volume.set(this.kindle.volume.get() + (last == 'volume_up' ? 1 : -1) * 100 / 15);
                        }

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

    constructor() {
        curl.get('http://127.0.0.1:8621')
            .then(v => {
                // console.log(v);
                // Acestream responds OK
            })
            .catch(e => {
                console.log("Acestream is not started!");
            });

        this.channelsHistoryConf.read();

        // Load acestream channels
        this.acestreamHistoryConf.read().then(conf => {
            if ((new Date().getTime() - conf.lastUpdate) / 1000 > 60*60) {
                curl.get("http://pomoyka.win/trash/ttv-list/as.json")
                    .then(text => {
                        const aceChannels = JSON.parse(text).channels as AceChannel[];
                        console.log("Downloaded " + aceChannels.length + " channels");
                        this.acestreamHistoryConf.change(conf => {
                            conf.channels = aceChannels;
                            conf.lastUpdate = new Date().getTime();
                        });
                    });
            }
            console.log("Read " + conf.channels.length + " channels");
        });

        // Load TV channels from different m3u lists
        this.tvChannels.read().then(conf => {
            if ((new Date().getTime() - conf.lastUpdate) / 1000 > 60*60) {
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
        });


        this.expressApi = express();

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

                            this.allInformers.runningLine('Подключено ' + clockController.name);

                            // Reload
                            this.reloadAllWebClients();

                            ws.on('error', () => { clockController.dropConnection(); });
                            ws.on('close', () => { clockController.dropConnection(); });
                        } else if (controller) {
                            controller.processMsg(objData);
                        } else {
                            console.error('Shall never be here', data);
                        }
                    } catch (e) {
                        console.error('Can not process message:', data, e);
                    }
                });
            } else if (url === '/web') {
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
            res.json(Array.from(this.tablets.values()).map(d => {
                return {
                    id: d.id,
                    name: d.name
                }
            }));
        });
        router.get('/tablet_screen', (req, res) => {
            this.kindle
                .screenshot()
                .then(buf => {
                    res.contentType('image/png');
                    buf.pipe(res);
                });
        });
        router.get('/index.html', (req, res) => {
            res.contentType('html');
            res.send(this.renderToHTML(
                this.onlineControllers.map((ctrl) => {
                    return Array.prototype.concat(
                        ctrl.name ? [ newWritableProperty("", ctrl.name, new SpanHTMLRenderer()) ] : [], 
                        ctrl.properties);
                })
            ));
        });
        router.get('/torrent_tv.html', (req, res) => {
            res.contentType('html');
            res.send(this.renderToHTML(
                this.acestreamHistoryConf.last().channels.map((h, index) => {
                    return Array.prototype.concat(
                        [ newWritableProperty("", "" + index + ".", new SpanHTMLRenderer()) ], 
                        [ newWritableProperty("", h.name, new SpanHTMLRenderer()) ],
                        this.makePlayButtonsForChannel(this.toAceUrl(h.url), h.name)
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
                        this.makePlayButtonsForChannel(h.url, h.name)
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
        })
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
                return ctrl.map((prop: Property<any>): string => {
                    let res = "";

                    res = prop.htmlRenderer.body(prop);

                    return res;
                }).join("&nbsp;\n");
            }).join("<hr/>\n"))
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

    public playURL(t: Tablet, _url: string, _name: string): Promise<void> {
        const url = _url.trim();
        const gotName = (name: string) => {
            // update history
            this.channelsHistoryConf.change(hist => {
                const index = hist.channels.findIndex(c => c.url === url);
                if (index == -1) {
                    hist.channels.splice(0, 0, {
                        "name": name,
                        "cat": "added",
                        "url": url
                    });
                } else {
                    // Move channel to the first place
                    const c = hist.channels[index];
                    hist.channels.splice(index, 1);
                    hist.channels.splice(0, 0, c);
                }
            }).then(() => {
                this.reloadAllWebClients();
            });;
        };
        if (!_name) {
            Promise.race([
                this.nameFromUrl(url).catch(() => url),
                util.delay(5000).then(() => url)
            ]).then(gotName);
        } else {
            gotName(_name);
        }

        this.r2.switch(true);

        return t.stopPlaying()
            .then(() => t.playURL(url));
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