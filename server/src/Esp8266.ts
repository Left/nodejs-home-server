import { Relay, Controller, Property, ClassWithId, PropertyImpl, SpanHTMLRenderer, Button, newWritableProperty, SliderHTMLRenderer, StringAndGoRendrer, CheckboxHTMLRenderer } from "./Props";
import { LcdInformer } from './Informer';
import { delay, toFixedPoint } from './Util';
import * as WebSocket from 'ws';

interface PingResult {
    type: 'pingresult';
    result: string;
    pingid: string;
    vcc?: number;
}

interface Msg {
    type: string;
    timeseq?: number;
}

interface Temp extends Msg {
    type: 'temp' | 'humidity' | 'pressure';
    value: number;
}

interface Weight extends Msg {
    type: 'weight';
    value: number;
}

interface ButtonPressed extends Msg {
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

interface LedStripeState extends Msg {
    type: 'ledstripeState';
    value: string;
}


type DevParams = {
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
    "hasBME280": string,           // Has BME280 (temp & humidity sensor)
    "hasButton": string,           // Has button on D7 "false"
    "brightness": string           // Brightness [0..100] "0"
    "relay.names": string          // Relay names, separated by ;
    "hasLedStripe": string         // Has LED stripe
};

export interface Hello extends Msg {
    type: 'hello';
    firmware: string;
    afterRestart: number;
    screenEnabled?: boolean; 
    devParams: DevParams;
}

interface IRKey extends Msg {
    type: 'ir_key';
    remote: string;
    key: string;
}

type AnyMessage = Log | Temp | Hello | IRKey | Weight | ButtonPressed | PingResult | RelayState | LedStripeState;

export interface ClockControllerEvents {
    onDisconnect: () => void;
    onWeatherChanged: (weather: { temp?: number, humidity?: number, pressure?: number}) => void;
    onWeightReset: () => void;
    onWeightChanged: (weight: number) => void;
    onIRKey: (remoteId: string, keyId: string) => void;
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

type LOWER = -1;
type EQUAL = 0;
type GREATER = 1;
type COMPARE_RES = LOWER | EQUAL | GREATER;

export class RGBA {
    constructor(
        public readonly r: number, 
        public readonly g: number,
        public readonly b: number,
        public readonly w: number) {
    }

    static validate(x: number): number {
        return Math.max(Math.min(Math.floor(x), 255), 0);
    }
    
    public transformTo(clr: RGBA, percent: number): RGBA {
        const f = (from: number, to: number): number => {
            return RGBA.validate(from + ((to - from) * percent / 100));
        };
        return new RGBA(f(this.r, clr.r), f(this.g, clr.g), f(this.b, clr.b), f(this.w, clr.w));
    }

    changeBrightness(percent: number) {
        const f = (from: number): number => {
            return RGBA.validate(from * (100 + percent) / 100);
        };
        return new RGBA(f(this.r), f(this.g), f(this.b), f(this.w));
    }

    public asString(): string {
        const f = (x: number): string => {
            const ret = x.toString(16);
            return (ret.length == 1 ? ('0' + ret) : ret).toUpperCase();
        } 
        return f(this.r) + f(this.g) + f(this.b) + f(this.w); 
    }

    public static parse(str: string): RGBA|undefined {
        return new RGBA(
            RGBA.validate(Number.parseInt(str.substr(0, 2), 16)),
            RGBA.validate(Number.parseInt(str.substr(2, 2), 16)),
            RGBA.validate(Number.parseInt(str.substr(4, 2), 16)),
            RGBA.validate(Number.parseInt(str.substr(6, 2), 16))
        )
    }

    public compare(rgbNow: RGBA): COMPARE_RES {
        if (this.r === rgbNow.r && this.g === rgbNow.g && this.b === rgbNow.b && this.w === rgbNow.w) {
            return 0;
        }
        return 1;
    }
}

export class ClockController extends ClassWithId implements Controller {
    protected pingId = 0;
    protected intervalId?: NodeJS.Timer;
    protected lastResponse = Date.now();
    private readonly _name: string;
    private readonly _properties: Property<any>[];
    public properties() { return this._properties; }
    public get name() { return this._name; }
    public readonly lcdInformer?: LcdInformer;
    public readonly internalName: string;

    public tempProperty = new PropertyImpl<number|undefined>(
        "Температура", 
        new SpanHTMLRenderer(v => v === undefined ? "Нет данных" : ((v > 0 ? "+" : "-") + v + "&#8451;")), 
        undefined);
    public humidityProperty = new PropertyImpl<number|undefined>(
        "Влажность", 
        new SpanHTMLRenderer(v => v === undefined ? "Нет данных" : (v + "%")), 
        undefined);
    public pressureProperty = new PropertyImpl<number|undefined>(
        "Давление", 
        new SpanHTMLRenderer(v => v === undefined ? "Нет данных" : (toFixedPoint(v, 0) + "Па (" + toFixedPoint(v*0.00750062, 1) + "мм рт ст)")), 
        undefined);
    public weightProperty = new PropertyImpl<string>(
        "Вес", 
        new SpanHTMLRenderer(), 
        "Нет данных");
    public screenEnabledProperty = newWritableProperty("Экран", false, new CheckboxHTMLRenderer(), 
        {
            onSet: (val: boolean) => {
                if (this.hasScreen()) {
                    this.send({ type: 'screenEnable', value: val });
                }
                if (this.devParams["hasLedStripe"] === 'true') {
                    this.ledStripeColorProperty.set(val ? '000000FF' : '00000000');
                }
            }
        });
    public brightnessProperty = newWritableProperty("Яркость", 
        0,
        new SliderHTMLRenderer(), 
        {
            onSet: (val: number) => {
                this.send({ type: 'brightness', value: val });
            }
        });
    public ledStripeColorProperty = newWritableProperty("Color", "", new StringAndGoRendrer("Set"), {
        onSet: (val, oldVal) => {
            const rgbNow = RGBA.parse(oldVal);
            const rgbTo = RGBA.parse(val);
            if (!rgbNow || !rgbTo) {
                // ?
            } else if (rgbTo.compare(rgbNow) !== 0) {
                (async () => {
                    for (var p = 0; p <= 255; p+=2) {
                        await delay(30);
                        if (val != this.ledStripeColorProperty.get()) {
                            // Color has changed. stop all flickering!
                            return;
                        }
                        const s = rgbNow.transformTo(rgbTo, p).asString();
                        this.send({ type: 'ledstripe', value: new Array(64).fill(s).join('') });
                    }
                })();
            }
        }});
    private static baseW: Map<string, number> = new Map();
    private baseWeight?: number;
    private lastWeight?: number;
    public readonly relays: ControllerRelay[] = [];
    private readonly devParams: DevParams;

    constructor(private readonly ws: WebSocket,
        public readonly ip: string,
        readonly hello: Hello,
        private readonly handler: ClockControllerEvents) {
        super();

        this.internalName = hello.devParams['device.name'];

        this._name = hello.devParams['device.name.russian'] || this.internalName;
        this.baseWeight = ClockController.baseW.get(this._name);
        this.lastResponse = Date.now();

        this._properties = [];
        this.devParams = hello.devParams;

        if (this.devParams['hasHX711'] === 'true') {
            this._properties.push(this.weightProperty);
            this._properties.push(Button.create("Weight reset", () => this.tare()));
        }
        if (this.devParams['hasLedStripe'] === 'true') {
            this._properties.push(this.screenEnabledProperty);
            this._properties.push(Button.create("ON", () => {
                this.ledStripeColorProperty.set('000000FF');
            }));
            this._properties.push(Button.create("OFF", () => {
                this.ledStripeColorProperty.set('00000000');
            }));
            this._properties.push(Button.create("GREEN", () => {
                this.ledStripeColorProperty.set('41F48900');
            }));
            this._properties.push(Button.create("ORANGE", () => {
                this.ledStripeColorProperty.set('F4B84100');
            }));
            this._properties.push(Button.create("ZIMA", () => {
                this.ledStripeColorProperty.set('42ADF400');
            }));
            this._properties.push(Button.create("+", () => {
                this.ledStripeColorProperty.set(RGBA.parse(this.ledStripeColorProperty.get())!.changeBrightness(10).asString());
            }));
            this._properties.push(Button.create("-", () => {
                this.ledStripeColorProperty.set(RGBA.parse(this.ledStripeColorProperty.get())!.changeBrightness(-10).asString());
            }));
            
            this._properties.push(this.ledStripeColorProperty);
        }
        if (this.devParams['hasDS18B20'] === 'true') {
            this._properties.push(this.tempProperty);
        }
        if (this.devParams['hasBME280'] === 'true') {
            this._properties.push(this.tempProperty, this.humidityProperty, this.pressureProperty);
        }
        if (this.hasScreen()) {
            this.lcdInformer = {
                runningLine: (str, totalMsToShow) => {
                    this.send({ type: 'show', totalMsToShow, text: str });
                },
                staticLine: (str) => {
                    this.send({ type: 'tune', text: str });
                },
                additionalInfo: (str) => {
                    this.send({ type: 'additional-info', text: str });
                }
            } as LcdInformer;
            this.brightnessProperty.setInternal(+hello.devParams.brightness);
            this.screenEnabledProperty.setInternal(hello.screenEnabled || true);
            this._properties.push(this.screenEnabledProperty);
            this._properties.push(this.brightnessProperty);
            this._properties.push(newWritableProperty("Go play", "", new StringAndGoRendrer("Play"), {
                onSet: (val) => this.send({ type: 'show', text: val })
            }));
        }
        if (!!this.devParams['relay.names']) {
            hello.devParams['relay.names']
                .split(';')
                .forEach((rn, index) => {
                    const relay = new ControllerRelay(this, index, rn);
                    this.relays.push(relay);
                    this._properties.push(relay);
                });
        }

        this._properties.push(Button.create("Restart", () => this.reboot()));

        this.intervalId = setInterval(() => {
            // console.log(this.name, "wasRecentlyContacted", this.wasRecentlyContacted());
            if (!this.wasRecentlyContacted()) {
                // 6 seconds passed, no repsonse. Drop the connection and re-try
                this.dropConnection();
            } else {
                this.send({ type: 'ping', pingid: ("" + (this.pingId++)) } as Ping);
            }
        }, 1500);

        console.log('Connected ' + this.name + ' (' + this.ip + ')');
    }

    public hasScreen() {
        return this.devParams["hasScreen"] === 'true';
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

    public async reboot(): Promise<void> {
        await this.send({ type: "reboot" });
        await delay(10);
        this.dropConnection();
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

    public toString(): string { return this.name; }

    protected wasRecentlyContacted() {
        return Date.now() - this.lastResponse < 18000;
    }

    private tare(): void {
        this.handler.onWeightReset();
        delay(500).then(() => {
            this.baseWeight = this.lastWeight;
            if (this.baseWeight) {
                ClockController.baseW.set(this._name, this.baseWeight);
            }
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
        const weatherHasChanged = () => {
            this.handler.onWeatherChanged({ temp: this.tempProperty.get(), humidity: this.humidityProperty.get(), pressure: this.pressureProperty.get() });
        }
        switch (objData.type) {
            case 'pingresult':
                if (objData.vcc && objData.vcc != -1 && objData.vcc != 0xffff) {
                    console.log("VCC:", objData.vcc);
                }
                // console.log(this._name, objData.pingid);
                break;
            case 'temp':
                this.tempProperty.setInternal(objData.value);
                weatherHasChanged();
                break;
            case 'humidity':
                this.humidityProperty.setInternal(objData.value);
                weatherHasChanged();
                break;
            case 'pressure':
                this.pressureProperty.setInternal(objData.value);
                weatherHasChanged();
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
                    ClockController.baseW.set(this._name, this.baseWeight);
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
            case 'ledstripeState':
                this.ledStripeColorProperty.setInternal(objData.value.substr(0, 8));
                break;
            default:
                console.log(this + " UNKNOWN CMD: ", objData);
        }
    }
}
