import { Relay, Controller, Property, ClassWithId, PropertyImpl, SpanHTMLRenderer, Button, newWritableProperty, SliderHTMLRenderer, StringAndGoRendrer, CheckboxHTMLRenderer, WritableProperty } from "./properties";
import { LcdInformer } from './informer.api';
import { delay, toFixedPoint } from './common.utils';

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

interface PotentiometerState extends Msg {
    type: 'potentiometer';
    value: number;
    timeseq: number;
}

interface LedStripeState extends Msg {
    type: 'ledstripeState';
    value: string;
}

interface AtxState extends Msg {
    type: 'atxState';
    value: number;
}

type DevParams = {
    "device.name": string,         // Device Name String("ESP_") + ESP.getChipId()
    "device.name.russian": string, // Device Name (russian)
    "wifi.name": string,           // WiFi SSID ""
    // "wifi.pwd": string,         // WiFi Password ""
    "websocket.server": string,    // WebSocket server ""
    "websocket.port": string,      // WebSocket port ""
    "invertRelay": string,         // Invert relays "false"
    "hasScreen": string,           // Has screen "true"
    "hasHX711": string,            // Has HX711 (weight detector) "false"
    "hasDS18B20": string,          // Has DS18B20 (temp sensor) "false"
    "hasBME280": string,           // Has BME280 (temp & humidity sensor)
    "hasButton": string,           // Has button on D7 "false"
    "hasButtonD2": string,         // Has button on D2 "false"
    "hasButtonD5": string,         // Has button on D5 "false"
    "brightness": string,          // Brightness [0..100] "0"
    "relay.names": string,         // Relay names, separated by ;
    "hasLedStripe": string,        // Has LED stripe
    "hasPotenciometer"?: string,   // Has potentiometer
    "hasGPIO1Relay"?: string,      // Has relay on D4
    "hasPWMOnD0"?: string,
    "hasDFPlayer"?: string
    "hasATXPowerSupply"?: string;
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

interface RawIRKey extends Msg {
    type: 'raw_ir_key';
    periods: number[];
    timeseq: number;
}

type AnyMessage = Log | Temp | Hello | IRKey | Weight | ButtonPressed | PingResult | RelayState | LedStripeState | PotentiometerState | AtxState | RawIRKey;

export type AnyMessageToSend = 
    { type: 'ping', pingid: string } |
    { type: 'reboot' } |
    { type: "unixtime", value: number } |
    { type: 'show'|'tune'|'additional-info', totalMsToShow?: number, text: string } |
    { type: 'switch', id: string, on: string } |
    { type: 'pwm', value: number, pin: string, period: number } |
    { type: 'playmp3', index: string } |
    { type: 'screenEnable', value: boolean } |
    { type: 'setvolume', value: string } |
    { type: 'atxEnable', value: boolean } |
    { type: 'brightness', value: number } |
    { type: 'ledstripe', value: string, period: number } |
    { type: 'ledstripe', newyear: true, basecolor: string, blinkcolors: string, period: number } |
    { type: 'screen', content: { width: number, height: number, content: Buffer }, offsets: { x: number, y: number, at: number }[] }
    ;

export interface ClockControllerEvents {
    onDisconnect: () => void;
    onWeatherChanged: (weather: { temp?: number, humidity?: number, pressure?: number}) => void;
    onWeightReset: () => void;
    onWeightChanged: (weight: number) => void;
    onIRKey: (remoteId: string, keyId: string) => void;
    onRawIrKey: (timeSeq: number, periods: number[]) => void;
    onRawDestinies: (timeSeq: number, destinies: number[]) => void;
    onPotentiometer: (value: number) => void;
}

class ControllerRelay extends Relay {
    constructor(
        private readonly controller: ClockController,
        private readonly index: number,
        readonly name: string,
        location: string) {
        super(name, location);
    }

    switch(on: boolean): Promise<void> {
        if (this.controller && this.controller.online) {
            return this.controller.send({
                type: 'switch',
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

export type ClockControllerCommunications = {
    send: (o: AnyMessageToSend) => void,
    disconnect: () => void
};

export class ClockController extends ClassWithId implements Controller {
    protected pingId = 0;
    public lastResponse = Date.now();
    private readonly _name: string;
    private readonly _properties: Property<any>[];
    public properties() { return this._properties; }
    public get name() { return this._name; }
    public readonly lcdInformer?: LcdInformer;
    public readonly internalName: string;

    public lastMsgLocal: number = 0; // result of millis() method passed to server

    public tempProperty = new PropertyImpl<number|undefined>(
        "Температура", 
        new SpanHTMLRenderer(v => (v === undefined ? "Нет данных" : ((v > 0 ? "+" : "-") + toFixedPoint(v, 1) + "&#8451;"))), 
        undefined);
    public humidityProperty = new PropertyImpl<number|undefined>(
        "Влажность", 
        new SpanHTMLRenderer(v => v === undefined ? "Нет данных" : (toFixedPoint(v, 1) + "%")), 
        undefined);
    public pressureProperty = new PropertyImpl<number|undefined>(
        "Давление", 
        new SpanHTMLRenderer(v => v === undefined ? "Нет данных" : (toFixedPoint(v, 0) + "Па (" + toFixedPoint(v*0.00750062, 1) + "мм рт ст)")), 
        undefined);
    public weightProperty = new PropertyImpl<string>(
        "Вес", 
        new SpanHTMLRenderer(), 
        "Нет данных");
    public atxEnabledProperty = newWritableProperty("Блок питания", false, new CheckboxHTMLRenderer(), 
        {
            onSet: (val: boolean) => {
                this.send({ type: 'atxEnable', value: val });
            }
        });
    public screenEnabledProperty = newWritableProperty("Экран", false, new CheckboxHTMLRenderer(), 
        {
            onSet: (val: boolean) => {
                if (this.hasScreen()) {
                    this.send({ type: 'screenEnable', value: val });
                }
                if (this.devParams["hasLedStripe"] === 'true') {
                    this.ledStripeColorProperty.set(val ? '000000FF' : '00000000');
                }
                if (this.devParams['hasATXPowerSupply'] === 'true') {
                    this.atxEnabledProperty.set(val);
                }
                if (this.devParams['hasGPIO1Relay'] === 'true') {
                    this.send({ type: 'screenEnable', value: val });
                }
                if (this.devParams["hasPWMOnD0"] === 'true') {
                    if (this.d4PWM) {
                        if (val) {
                            this.d4PWM.set(28);
                        } else {
                            this.d4PWM.set(0);
                        }
                    }
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
            const rgbTo = RGBA.parse(val);
            if (rgbTo) {
                this.send({ type: 'ledstripe', value: new Array(64).fill(rgbTo.asString()).join(''), period: 800 });
            }
        }});
    public potentiometerProperty = newWritableProperty('Potentiometer', 0, new SpanHTMLRenderer(x => x.toString(10)));
    public readonly d4PWM?: WritableProperty<number>;

    private static baseW: Map<string, number> = new Map();
    private baseWeight?: number;
    private lastWeight?: number;
    public readonly relays: ControllerRelay[] = [];
    private readonly devParams: DevParams;

    constructor(private readonly ws: ClockControllerCommunications,
        public readonly ip: string,
        readonly hello: Hello,
        private readonly handler: ClockControllerEvents) {
        super();

        this.internalName = hello.devParams['device.name'];

        this._name = (hello.devParams['device.name.russian'] || this.internalName);
        this.baseWeight = ClockController.baseW.get(this._name);
        this.lastResponse = Date.now();

        this._properties = [];
        this.devParams = hello.devParams;

        if (this.devParams['hasHX711'] === 'true') {
            this._properties.push(this.weightProperty);
            this._properties.push(Button.create("Weight reset", () => this.tare()));
        }
        if (this.devParams['hasDFPlayer'] === 'true') {
            // Nothing ATM
        }
        if (this.devParams['hasPWMOnD0'] === 'true' || 
            this.devParams['hasATXPowerSupply'] === 'true' ||
            this.devParams['hasGPIO1Relay'] === 'true') {
            this._properties.push(this.screenEnabledProperty);
        }
        if (this.devParams['hasPWMOnD0'] === 'true') {
            this.d4PWM = this.createPWMProp("D4");   
            this._properties.push(this.d4PWM);
        }
        if (this.devParams['hasATXPowerSupply'] === 'true') {
            this._properties.push(this.atxEnabledProperty);
        }
        if (this.devParams['hasLedStripe'] === 'true') {
            this._properties.push(this.screenEnabledProperty);
            this._properties.push(Button.create("ON", () => {
                this.ledStripeColorProperty.set('000000FF');
            }));
            this._properties.push(Button.create("OFF", () => {
                this.ledStripeColorProperty.set('00000000');
            }));
            this._properties.push(Button.create("+", () => {
                this.ledStripeColorProperty.set(RGBA.parse(this.ledStripeColorProperty.get())!.changeBrightness(10).asString());
            }));
            this._properties.push(Button.create("-", () => {
                this.ledStripeColorProperty.set(RGBA.parse(this.ledStripeColorProperty.get())!.changeBrightness(-10).asString());
            }));
            this._properties.push(Button.create("New Year", () => {
                this.send({ type: 'ledstripe', 
                    newyear: true, 
                    basecolor: "00080000", 
                    blinkcolors: Array.prototype.concat(
                        Array(2).fill("0000FF00"),
                        Array(3).fill("00008000"),
                        // Array(2).fill("00FFFF00"),
                        // Array(2).fill("FFFF0000"),
                        Array(2).fill("FF00FF00"),
                        // Array(3).fill("FF000000")
                        )
                            .join(''), 
                    period: 8000 });
            }));
            this._properties.push(Button.create("New Year (fast)", () => {
                this.send({ type: 'ledstripe', 
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
            }));
            this._properties.push(Button.create("Disko", () => {
                this.send({ type: 'ledstripe', 
                    newyear: true, 
                    basecolor: "00000020", 
                    blinkcolors: Array.prototype.concat(
                        Array(2).fill("0000FF00"),
                        Array(2).fill("00008000"),
                        Array(1).fill("00FFFF00"),
                        Array(1).fill("FFFF0000"),
                        Array(1).fill("FF00FF00"),
                        Array(4).fill("FF000000"))
                            .join(''), 
                    period: 4000 });
            }));

            this._properties.push(this.ledStripeColorProperty);
        }
        if (this.devParams['hasPotenciometer'] === 'true') {
            if (this.devParams['hasScreen'] === 'false') {
                // Potentiometer is connected
                this._properties.push(this.potentiometerProperty);
            } else {
                // Light sensor is connected
            }
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
            // this._properties.push(this.brightnessProperty);
            this._properties.push(newWritableProperty("Бегущая строка", "", new StringAndGoRendrer("Play"), {
                onSet: (val) => this.send({ type: 'show', text: val })
            }));
        }
        if (!!this.devParams['relay.names']) {
            hello.devParams['relay.names']
                .split(';')
                .forEach((rn, index) => {
                    const relay = new ControllerRelay(this, index, rn, this.name);
                    if (!!relay.name) {
                        this.relays.push(relay);
                        this._properties.push(relay);
                    }
                });
        }

        this._properties.push(Button.create("Restart", () => this.reboot()));
        const ipA = this.ip.match(/(\d*\.\d*\.\d*\.\d*)/);
        if (ipA) {
            this._properties.push(Button.createClientRedirect("Open settings", "http://" + ipA[0]));
        }
    }

    public hasScreen() {
        return this.devParams["hasScreen"] === 'true';
    }

    public hasPWM() {
        return this.devParams["hasPWMOnD0"] === 'true';
    }

    public get online() {
        return this.wasRecentlyContacted();
    }

    public dropConnection() {
        this.handler.onDisconnect();
        this.ws.disconnect();
    }

    public async reboot(): Promise<void> {
        await this.send({ type: 'reboot' });
        await delay(10);
        this.dropConnection();
    }

    public send(json: AnyMessageToSend): Promise<void> {
        try {
            this.ws.send(json);
        } catch (err) {
            // Failed to send, got error, let's reconnect
            console.log(err);
            this.dropConnection();
        }
        return Promise.resolve(void 0);
    }

    public toString(): string { return this.name; }

    public wasRecentlyContacted() {
        return (Date.now() - this.lastResponse) < 18000;
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
            case 'raw_ir_key':
                // this.handler.onIRKey(objData.remote, objData.key);
                // console.log(objData.timeseq, objData.periods.length);
                this.handler.onRawIrKey(objData.timeseq, objData.periods);
                break;
            case 'relayState':
                // console.log(this + " " + "relayState: ", objData.id, objData.value);
                this.setRelayState(objData.id, objData.value);
                break;
            case 'ledstripeState':
                this.ledStripeColorProperty.setInternal(objData.value.substr(0, 8));
                break;
            case 'potentiometer':
                const v = objData.value;
                this.handler.onPotentiometer(v);
                this.potentiometerProperty.set(v);
                break;
            case 'atxState':
                console.log('ATX state', objData.value);
                break;
            default:
                console.log(this + " UNKNOWN CMD: ", objData);
        }
    }

    public setRelayState(id: number, value: boolean): void {
        this.relays[id].setInternal(value);
    }

    public playMp3(index: number): void {
        // console.log(this.name, JSON.stringify({ type: 'playmp3', index: "" + index }));
        this.send({ type: 'playmp3', index: "" + index });
    }

    public setVol(vol: number): void {       
        const value = "" + Math.round(Math.max(0, Math.min(30, (vol*30/100))));
        // console.log(this.name, JSON.stringify({ type: 'setvolume', value }));
        this.send({ type: 'setvolume', value });
    }

    private createPWMProp(pin: string): WritableProperty<number> {
        return newWritableProperty<number>(pin, 0, new SliderHTMLRenderer(), {
            onSet: (val: number) => {
                this.send({ type: 'pwm', value: val, pin, period: 500 });
            }})
    }

    public async play(vol: number, mp3index: number): Promise<void> {
        await this.setVol(vol);
        await delay(200);
        await this.playMp3(mp3index);
    }

    public static readonly _mp3Names: ([number, string, number])[] = [
        [   1, "Труба трубит “отбой”", 33.985250],
        [   2, "Труба трубит “сбор”", 22.987750],
        [   3, "Труба трубит “равнение на знамя”", 17.031812],
        [   4, "Сигнал горна - тревога", 9.116687],
        [   5, "Сигнал горна – фанфара", 7.941187],
        [   6, "Труба трубит “заряжай”", 17.946063],
        [   7, "Труба трубит “подъем”", 21.995062],
        [   8, "Сигнал горна - приветствие гвардии", 26.253062],
        [   9, "Сигнал горна - становись", 18.599125],
        [  10, "Сигнал горна - побудка", 29.962438],
        [  11, "Сигнал горна - поверка", 40.437500],
        [  12, "Сигнал горна - пожарная тревога", 13.818750],
        [  13, "Сигнал горна - привал", 15.177125],
        [  14, "Сигнал горна - отбой  2", 30.093063],
        [  15, "Сигнал горна - отбой 2", 13.635875],
        [  16, "Сигнал горна - отбой", 13.348562],
        [  17, "Сигнал горна - отступление", 11.467750],
        [  18, "Сигнал горна - королевское приветствие", 21.106938],
        [  19, "Сигнал горна - окончание парада", 18.912625],
        [  20, "Сигнал горна  - на обед", 12.042438],
        [  21, "Сигнал горна - викинги", 26.827750],
        [  22, "Сигнал горна - заряжай", 10.971375],
        [  23, "Почтовый горн 2", 13.087312],
        [  24, "Почтовый горн", 11.415500],
        [  25, "Литавры -нота ля", 8.489750],
        [  26, "Литавры -нота соль", 7.523250],
        [  27, "Литавры", 8.463625],
        [  28, "Удар по литаврам", 6.008125],
        [  29, "Звук литавры  ( вверх -вниз)", 5.433438],
        [  30, "Литавры 2", 7.079125],
        [  31, "Сверчки ночью - 1", 63.791000],
        [  32, "Сверчок", 57.600000],
        [  33, "Сверчки ночью – 2", 35.970562],
        [  34, "Рой саранчи", 46.053875],
        [  35, "Пчёлы", 25.077500],
        [  36, "На пруду - сверчки, лягушки", 50.050563],
        [  37, "Пчелиный улей", 44.591000],
        [  38, "Пчела", 35.160812],
        [  39, "Лягушки, птицы и другие звуки на болоте", 50.024437],
        [  40, "Лягушки", 39.444875],
        [  41, "Лягушка-вол", 33.906937],
        [  42, "Лягушка -вол  и насекомые", 66.115875],
        [  43, "Лягушка- вол", 30.066938],
        [  44, "Комар  2", 37.015500],
        [  45, "Комар", 24.790188],
        [  46, "Звук сверчков, шум транспорта на заднем плане", 51.043250],
        [  47, "Кваканье лягушек", 50.076687],
        [  48, "Жужжание пчел вокруг улья", 63.268563],
        [  49, "Звук сверчка", 23.980375],
        [  50, "Жужжание мухи", 17.031812],
        [  51, "Человек осел", 20.009750],
        [  52, "Человек- обезьяна", 23.040000],
        [  53, "Человек- курица", 16.039125],
        [  54, "Человек- мартышка", 29.048125],
        [  55, "Фантастические звуки", 82.076688],
        [  56, "Человек- корова", 38.034250],
        [  57, "Человек- горилла", 51.095500],
        [  58, "Тревога ” Чужой !”", 35.030187],
        [  59, "Скрежет ногтей по школьной доске", 27.036687],
        [  60, "Смех злой колдуньи", 9.377937],
        [  61, "Сумашедший", 9.064438],
        [  62, "Прерывистое сердцебиение", 66.037500],
        [  63, "Скрежет   зловещего  фортепиано", 14.053875],
        [  64, "Скрежещущий звук гонга", 11.049750],
        [  65, "Рычание монстра", 19.043250],
        [  66, "Пресс-эффект на зловещем фортепиано", 14.001625],
        [  67, "Причудливые завывания привидения", 12.042438],
        [  68, "Писк летучих мышей -вампиров", 45.035063],
        [  69, "Последний вздох", 16.013063],
        [  70, "Пение гиббона", 44.042438],
        [  71, "Писк гигантских летучих мышей", 29.074250],
        [  72, "Мужской стон", 25.025250],
        [  73, "Неполадки в космическом аппарате", 35.030187],
        [  74, "Механическое сердцебиение", 43.049750],
        [  75, "Мужской крик", 7.993438],
        [  76, "Мужской стон от боли", 13.035063],
        [  77, "Кричащие женщины", 14.106063],
        [  78, "Мужской крик ужаса", 8.045688],
        [  79, "Мужской крик ” Нет,нет, нет !”", 8.071813],
        [  80, "Космический звук  2", 38.060375],
        [  81, "Космический звук 1", 18.024438],
        [  82, "Космическое эхо", 10.031000],
        [  83, "Космические звуки", 93.048125],
        [  84, "Космический гонг", 14.027750],
        [  85, "Космическая тревога", 66.011375],
        [  86, "Космические куранты", 16.065250],
        [  87, "Имитация фисгармонии на зловещем фортепиано", 35.056312],
        [  88, "Звуки привидения", 22.073438],
        [  89, "Зловещее фортепиано - различные звуки", 31.033438],
        [  90, "Имитация звука арфы на    зловещем  фортепиано", 9.012187],
        [  91, "Дыхание при агонии 2", 52.035875],
        [  92, "Женский крик ужаса", 7.026938],
        [  93, "Женский крик", 7.026938],
        [  94, "Женский пронзительный визг", 6.034250],
        [  95, "Задыхающаяся женщина", 5.015500],
        [  96, "Задыхающийся мужчина", 6.060375],
        [  97, "Дыхание при агонии 1", 57.077500],
        [  98, "Драматический электронный эффект2", 21.028562],
        [  99, "Дыхание монстра", 21.002437],
        [ 100, "Виброфон", 12.068562],
        [ 101, "Глиссандо   на зловещем фортепиано", 18.024438],
        [ 102, "Драматический электронный эффект1", 12.042438],
        [ 103, "Ужасный смех", 14.027750],
        [ 104, "Смех малыша", 34.429375],
        [ 105, "Смех небольшой группы людей", 15.229375],
        [ 106, "Смех старушки", 7.993438],
        [ 107, "Спорящие мужчины", 14.027750],
        [ 108, "Плач малыша", 36.075063],
        [ 109, "Плач", 10.057125],
        [ 110, "Пронзительный мужской крик", 9.926500],
        [ 111, "Крик женщины", 8.254688],
        [ 112, "Мужской смех", 20.035875],
        [ 113, "Зловещий мужской смех (c эхом )", 14.288937],
        [ 114, "Зловещий мужской смех", 13.165688],
        [ 115, "Изображение человеком волчьего воя", 8.515875],
        [ 116, "Истерический мужской смех", 13.113437],
        [ 117, "Женский смех 2", 13.505250],
        [ 118, "Женский смех", 8.594250],
        [ 119, "Женское рыдание 2", 14.236688],
        [ 120, "Женское рыдание", 11.128125],
        [ 121, "Детский смех", 13.035063],
        [ 122, "Женский визг", 11.075875],
        [ 123, "Женский смех  2", 19.043250],
        [ 124, "Щебет птиц на рассвете в деревне", 63.451375],
        [ 125, "Визг смеющейся женщины", 15.072625],
        [ 126, "Вздох облегчения небольшой группы людей", 4.702000],
        [ 127, "Цыплята", 36.911000],
        [ 128, "Чайки", 20.114250],
        [ 129, "Хищная птица", 38.008125],
        [ 130, "Цыплята в курятнике", 20.009750],
        [ 131, "Стая уток , плеск крыльев по воде", 47.020375],
        [ 132, "Тропические птицы", 62.511000],
        [ 133, "Порханье птиц", 25.025250],
        [ 134, "Сова", 36.048938],
        [ 135, "Пение птиц на рассвете", 64.653063],
        [ 136, "Писк цыплят , куры и петухи на заднем плане", 50.991000],
        [ 137, "Пенье нескольких птиц", 14.419562],
        [ 138, "Павлин", 17.240813],
        [ 139, "Пение птиц", 8.124063],
        [ 140, "Кряканье и плескание уток", 49.998312],
        [ 141, "Павлин  2", 8.986062],
        [ 142, "Кряканье и плескание уток и гусей", 14.994250],
        [ 143, "Кудахтанье кур", 6.974687],
        [ 144, "Крик лебедя на фоне шума воды", 49.998312],
        [ 145, "Крик совы", 22.909375],
        [ 146, "Крик ястреба", 16.039125],
        [ 147, "Журавли, цапли и коршуны", 125.831812],
        [ 148, "Карканье вороны , звуки других птиц вдалеке", 36.937125],
        [ 149, "Крик петуха", 7.235875],
        [ 150, "Канарейки", 40.437500],
        [ 151, "Индейки", 28.238312],
        [ 152, "Двухнедельный утенок", 110.497937],
        [ 153, "Дикие петухи", 21.629375],
        [ 154, "Гуси", 26.253062],
        [ 155, "Гуси и утки", 38.844062],
        [ 156, "Голуби в зоомагазине", 33.410563],
        [ 157, "Голуби", 31.895500],
        [ 158, "В курятнике", 46.471813],
        [ 159, "Воробьи", 36.414687],
        [ 160, "Раскат грома", 7.575500],
        [ 161, "Продолжительные раскаты грома", 64.940375],
        [ 162, "Проливной дождь", 64.888125],
        [ 163, "Раскат грома   3", 16.195875],
        [ 164, "Раскат грома  2", 11.363250],
        [ 165, "После бури", 35.840000],
        [ 166, "После грозы", 32.757500],
        [ 167, "Дождь с грозой", 120.032625],
        [ 168, "Зарница", 10.031000],
        [ 169, "Дождь", 51.069375],
        [ 170, "Дождь с грозой     2", 51.017125],
        [ 171, "Грозовой ветер и дождь", 64.522437],
        [ 172, "Дождь на пруду", 35.030187],
        [ 173, "Грозовая буря с дождем", 65.280000],
        [ 174, "Гроза и проливной дождь", 62.824437],
        [ 175, "Буря, косой дождь", 62.406500],
        [ 176, "Гроза", 8.071813],
        [ 177, "Шум ветра", 62.589375],
        [ 178, "Сильный ветер", 50.050563],
        [ 179, "Шум ветра на фоне океана", 31.033438],
        [ 180, "Легкое завывание ветра", 65.201625],
        [ 181, "Мощные порывы ветра", 50.050563],
        [ 182, "Завывание ветра 2", 65.462812],
        [ 183, "Завывание ветра", 63.529750],
        [ 184, "Ветер в деревьях", 66.142000],
        [ 185, "Ветренный день в гавани", 27.115063],
        [ 186, "Ветер 6", 92.029375],
        [ 187, "Ветер 5", 57.051375],
        [ 188, "Ветер 4", 64.078313],
        [ 189, "Ветер 3", 78.001625],
        [ 190, "Ветер 2", 84.114250],
        [ 191, "Буря ночью", 97.044875],
        [ 192, "Ветер 1", 53.995062],
        [ 193, "Часы на церкви бьют 12 часов", 63.451375],
        [ 194, "Часы с кукушкий бьют 1 час", 8.724875],
        [ 195, "Часы с кукушкий бьют 12 часов", 16.613875],
        [ 196, "Тиканье каминных часов", 65.671813],
        [ 197, "Тиканье нескольких  каминных часов", 64.966500],
        [ 198, "Часы на церкви бьют 1 час", 32.626937],
        [ 199, "Городские часы бьют вдалеке 12 часов", 61.152625],
        [ 200, "Старинные часы бьют 12 часов", 54.517500],
        [ 201, "Городские часы бьют вдалеке 1 час", 32.705250],
        [ 202, "Бубенцы приближаются", 36.728125],
        [ 203, "Будильник", 15.673438],
        [ 204, "Позвякивание колокольчиков", 32.888125],
        [ 205, "Бубенчик", 3.160813],
        [ 206, "Чайки -на побережье", 44.016312],
        [ 207, "Бубенцы отдаляются", 26.200813],
        [ 208, "Чайки -возле дока", 50.050563],
        [ 209, "Чайки   на фоне прибоя", 61.701187],
        [ 210, "Чайки - звук разбивающихся волн", 50.102812],
        [ 211, "Серфинг - общая атмосфера", 62.406500],
        [ 212, "Порог быстрой реки", 63.216312],
        [ 213, "Подземный водопад", 50.076687],
        [ 214, "Плеск воды о берег", 50.050563],
        [ 215, "Под водой", 46.001625],
        [ 216, "Небольшой водоворот", 50.076687],
        [ 217, "Океанское побережье", 53.002438],
        [ 218, "Море- лодки на воде", 123.402438],
        [ 219, "Морская пещера", 50.076687],
        [ 220, "Маленький водопад", 50.102812],
        [ 221, "Звук разбивающихся волн", 55.040000],
        [ 222, "Журчащий ручей", 49.998312],
        [ 223, "Горный источник", 50.050563],
        [ 224, "Всплеск рыбы в воде", 34.037500],
        [ 225, "Глубоко под водой", 28.055500],
        [ 226, "Вода, капающая в пещере", 32.365687],
        [ 227, "Бурлящий ручей", 65.933062],
        [ 228, "Быстрые горные пороги", 52.009750],
        [ 229, "Бурлящий поток", 63.294688],
        [ 230, "Большой водопад", 49.920000],
        [ 231, "Бегущий поток", 48.091375],
        [ 232, "Шаги в лесу", 41.038312],
        [ 233, "Шаги по корридору", 21.995062],
        [ 234, "Чудовище ,подволакивающее ногу", 30.040812],
        [ 235, "Бег справа налево", 15.490562],
        [ 236, "Звук шагов по листьям", 23.797500],
        [ 237, "Бег по опавшей листве", 18.364062],
        [ 238, "Бег слева направо", 14.994250],
        [ 239, "Удар большого гонга", 26.070187],
        [ 240, "Удар гонга", 3.892188],
        [ 241, "Кастаньеты", 20.035875],
        [ 242, "Удар в гонг", 11.049750],
        [ 243, "Барабаны в пещере", 33.175500],
        [ 244, "Быстрый ритм  барабанов", 33.567312],
        [ 245, "Звук бубна", 6.295500],
        [ 246, "Звук турецкого барабана", 3.004063],
        [ 247, "Барабанная дробь2", 11.990187],
        [ 248, "Барабанная дробь3", 8.986062],
        [ 249, "Бубен", 3.317500],
        [ 250, "Барабанная дробь", 36.022813],
        [ 251, "Барабанная дробь1", 26.984437],
        [ 252, "Барабанная дробь и  духовой инструмент -1", 36.937125],
        [ 253, "Барабанная дробь и  духовой инструмент -2", 36.022813],
        [ 254, "Барабанная дробь, звук тарелок", 7.262000],
        [ 255, "Барабан", 6.060375],
        [ 256, "Щенки в зоомагазине", 28.839125],
        [ 257, "Щенок", 17.867750],
        [ 258, "Хрюканье свиней в хлеву", 62.746063],
        [ 259, "Шимпанзе в зоомагазине", 30.249750],
        [ 260, "Шипение лесного кота", 5.955875],
        [ 261, "Фырканье верблюда", 18.050562],
        [ 262, "Трубящий слон , птицы на заднем плане", 45.975500],
        [ 263, "Ферма - общая атмосфера", 59.376312],
        [ 264, "Трещетка гремучей змеи", 34.037500],
        [ 265, "Трубит разъяренный слон", 7.418750],
        [ 266, "Тигрица", 57.573875],
        [ 267, "Травля английскими гончими", 34.612188],
        [ 268, "Табун лошадей, скучущих галопом", 16.091375],
        [ 269, "Стадо овец", 49.998312],
        [ 270, "Стадо слонов", 62.667750],
        [ 271, "Собачий лай", 7.862813],
        [ 272, "Скулящий щенок", 35.291375],
        [ 273, "Собака рычит и лает", 30.824437],
        [ 274, "Собачий лай 2", 18.991000],
        [ 275, "Слон трубит", 11.441625],
        [ 276, "Собака гонится за  человеком и лает", 10.057125],
        [ 277, "Скулящая собака", 33.985250],
        [ 278, "Скулящие собаки", 42.866937],
        [ 279, "Скулящий щенок  2", 25.991812],
        [ 280, "Свиньи  хрюкают в хлеву", 63.791000],
        [ 281, "Свинья хрюкает и убегает", 12.669375],
        [ 282, "Свиньи", 27.533063],
        [ 283, "Рычание собаки", 23.379562],
        [ 284, "Рычанье льва", 20.323250],
        [ 285, "Рычание медведей", 51.983625],
        [ 286, "Рычание собаки  2", 24.058750],
        [ 287, "Рычание медведя", 19.017125],
        [ 288, "Рычание крокодила", 53.106938],
        [ 289, "Рычание лесного кота", 46.994250],
        [ 290, "Рычание льва  вблизи", 11.937938],
        [ 291, "Рычание и лай собаки", 32.548562],
        [ 292, "Ржанье лошади 2", 16.640000],
        [ 293, "Рычание горного льва", 32.862000],
        [ 294, "Ржание и фырканье лошадей", 28.186062],
        [ 295, "Ржание лошади  2", 8.045688],
        [ 296, "Ржание лошади", 8.385250],
        [ 297, "Ржанье лошади", 2.873438],
        [ 298, "Пара лошадей, скачущих рысью  по асфальту", 49.737125],
        [ 299, "Погон скота", 43.728938],
        [ 300, "Разъяренные слоны", 11.467750],
        [ 301, "Рев осла", 11.049750],
        [ 302, "Пение петуха", 6.269375],
        [ 303, "Мяукающий котенок", 22.700375],
        [ 304, "Овцы козлы козлята", 32.313437],
        [ 305, "Мяуканье котёнка", 36.022813],
        [ 306, "Мяукающие котята", 24.320000],
        [ 307, "Мурлыкающая и мяукающая кошка", 94.040813],
        [ 308, "Мяуканье кошки", 27.977125],
        [ 309, "Мыши", 25.051375],
        [ 310, "Мурлыкающий котенок", 20.401625],
        [ 311, "Мычание коровы", 5.459563],
        [ 312, "Мычанье коровы", 2.873438],
        [ 313, "Морские свинки", 32.574688],
        [ 314, "Мурлыканье кошки", 28.943625],
        [ 315, "Медведь", 97.410562],
        [ 316, "Морские львы", 33.645688],
        [ 317, "Мауканье кошек", 27.585250],
        [ 318, "Львиный рык 2", 67.448125],
        [ 319, "Львы", 60.055500],
        [ 320, "Львиный рык", 16.274250],
        [ 321, "Лошадь ходит по конюшне и фыркает", 14.341187],
        [ 322, "Лошадь- ходит по конюшне и громко фыркает", 13.008938],
        [ 323, "Львиный рык 3", 9.012187],
        [ 324, "Лошадь ест овес", 63.425250],
        [ 325, "Лошадь скачет легким галопом", 14.576313],
        [ 326, "Лошадиный галоп", 11.102000],
        [ 327, "Лошадь бежит рысью и фыркает", 12.251375],
        [ 328, "Лошадиный галоп 2", 29.335500],
        [ 329, "Лошадиный галоп 3", 13.975500],
        [ 330, "Лошадиное ржанье в стойле", 44.486500],
        [ 331, "Лошадиное фырканье", 4.963250],
        [ 332, "Лай пуделя на улицы", 92.473438],
        [ 333, "Лев", 31.738750],
        [ 334, "Лай собаки", 5.093875],
        [ 335, "Лай луговой собачки , деревенская атмосферва", 23.980375],
        [ 336, "Кудахтанье курицы", 65.149375],
        [ 337, "Лай котиков и морских львов", 50.050563],
        [ 338, "Кряканье утки", 4.989375],
        [ 339, "Крик лося", 28.029375],
        [ 340, "Крик осла , общая атмосфера на ферме", 32.992625],
        [ 341, "Крик осла", 18.050562],
        [ 342, "Крик верблюда , водопад и птицы на заднем плане", 23.954250],
        [ 343, "Кормление свиней", 80.953438],
        [ 344, "Кошки", 32.496313],
        [ 345, "Кошки и котята", 29.884063],
        [ 346, "Кошка", 21.133062],
        [ 347, "Котенок", 22.726500],
        [ 348, "Кошачье мяуканье - 3 вида", 10.893063],
        [ 349, "Коровник", 37.093875],
        [ 350, "Козел", 30.981188],
        [ 351, "Касатки", 67.317500],
        [ 352, "Кашалот", 46.027750],
        [ 353, "Злобное рычание собаки", 42.057125],
        [ 354, "Домашние животные", 92.995875],
        [ 355, "Животные в загоне", 50.938750],
        [ 356, "Зловещий кошачий крик", 8.045688],
        [ 357, "Дикие собаки", 60.342813],
        [ 358, "Дыхание  лошади , ходящей по конюшне", 25.861187],
        [ 359, "Дикие собаки и волки", 50.050563],
        [ 360, "Горилла", 49.998312],
        [ 361, "Волчий вой , другие волки вдалеке", 49.998312],
        [ 362, "Горбатый кит в неволе", 39.366500],
        [ 363, "Галоп лошади", 11.964063],
        [ 364, "Вой и лай стаи волков", 95.111812],
        [ 365, "Вой койота", 20.976312],
        [ 366, "Вой волчей стаи вдалеке", 41.952625],
        [ 367, "В зоопарке  шимпанзе, зебры, слоны, носорог , медведь", 21.577125],
        [ 368, "Вой волков", 26.017938],
        [ 369, "Визг свиньи", 11.023625],
        [ 370, "Бурундук , деревенская атмосфера", 33.784313],
        [ 374, "Блеянье козла", 1.149375],
        [ 375, "Одобрительные апплодисменты маленькой группы людей", 17.475875],
        [ 376, "Одобрительные апплодисменты перед концертом", 17.606500],
        [ 377, "Смех, апплодисменты в небольшой группе", 12.695500],
        [ 378, "Вежливые апплодисменты небольшой группы", 50.755875],
        [ 379, "Громкие апплодисменты группы людей", 50.938750],
        [ 380, "Игра в гольф-аплодисменты", 11.337125],
        [ 381, "Апплодисменты и крики на рок- концерте", 74.422813],
        [ 382, "Апплодисменты маленькой аудитории", 15.568938],
        [ 383, "Апплодисменты", 12.512625],
        [ 384, "Апплодисменты и крики одобрения на концерте", 16.561625],
        [ 385, "Апплодисменты в большой аудитории", 39.941188],
        [ 386, "Аплодисменты при поздравлении", 6.034250],
        [ 387, "Щебетание птиц- ночь в сельской местности", 50.024437],
        [ 388, "Щебетание стайки птиц, сверчки ,нехрущи июньские , общая атмосфера в лесу", 49.711000],
        [ 389, "Щебетание птиц в городе", 50.024437],
        [ 390, "Щебетание и пение птиц в лесу", 49.998312],
        [ 391, "Щебетание и пение птиц в тишине", 49.998312],
        [ 392, "Тропический южноамериканский лес , звук водопада", 49.972188],
        [ 393, "Пение козодоя - сверчки на заднем плане", 50.024437],
        [ 394, "Петушиное пение , общая деревенская атмосфера", 28.943625],
        [ 395, "Ночь в сельской местности", 49.920000],
        [ 396, "Пение и щебетание птиц на фоне звука водопада в лесу", 50.024437],
        [ 397, "Ночью в лесу", 38.034250],
        [ 398, "На ферме - петухи, коровы ,птицы на заднем плане", 49.998312],
        [ 399, "Летом в деревне", 65.175500],
        [ 400, "Животное пробирается сквозь джунгли , крики животных", 54.961625],
        [ 401, "Глубоко в джунглях", 98.977937],
        [ 402, "Дятел стучит по дереву- другие птицы вдалеке", 50.024437],
        [ 403, "В джунглях - крики птиц, шум воды", 50.991000],
        [ 404, "Азиатский тропический дождевой лес", 51.017125],
        [ 405, "Элетробритва", 40.829375],
        [ 406, "Циркулярная пила", 62.040813],
        [ 407, "Электропила", 15.072625],
        [ 408, "Электроточилка  для карандашей", 3.866062],
        [ 409, "Работающий пылесос", 64.078313],
        [ 410, "Фотоаппарат-авт . смена кадра", 12.303625],
        [ 411, "Торговый автомат - продажа прохладительных напитков", 14.001625],
        [ 412, "Фотоаппарат - вспышка заряжается и срабатывает", 9.613062],
        [ 413, "Ручной воздушный насос", 17.998313],
        [ 414, "Работающая игрушечная машинка", 32.548562],
        [ 415, "Работающий гидравлический лифт", 32.470187],
        [ 416, "Работа посудомоечной машины", 61.544437],
        [ 417, "Работа фена", 40.829375],
        [ 418, "Работа циркулярной пилы", 18.729750],
        [ 419, "Работа установки по переработке отходов", 11.833438],
        [ 420, "Пропил дерева циркулярной пилой", 48.848937],
        [ 421, "Работа игрушечной машинки", 34.351000],
        [ 422, "Работа вентилятора", 21.707750],
        [ 423, "Подъем на лифте ( ощущения пассажира)", 24.267750],
        [ 424, "Прачечная", 65.985250],
        [ 425, "Пар", 21.342000],
        [ 426, "Перископ подводной лодки в работе", 18.024438],
        [ 427, "Моторное отделение корабля", 90.044063],
        [ 428, "Мытье машины- с позиции находящегося в салоне", 64.966500],
        [ 429, "Открывающиеся двери лифта", 8.803250],
        [ 430, "Магазин механических игрушек", 63.764875],
        [ 431, "Морозильная камера для мяса", 30.040812],
        [ 432, "Монстр оживает", 50.076687],
        [ 433, "Кофе фильтруется", 35.030187],
        [ 434, "Кофемолка", 10.762438],
        [ 435, "Космическая лаборатория 1", 108.042438],
        [ 436, "Космическая лаборатория 2", 81.084063],
        [ 437, "Кондиционер включают и выключают", 61.884062],
        [ 438, "Конвейер на фабрике", 61.910188],
        [ 439, "Звук элекрической открывалки банок", 14.445688],
        [ 440, "Игровой автомат и выдача денег", 6.530563],
        [ 441, "Заправка бензином на бензоколонке", 63.216312],
        [ 442, "Звук старого кинопроектора", 35.631000],
        [ 443, "Загрузка мусоровозной машины", 61.309375],
        [ 444, "Закрывающиеся двери лифта", 11.493875],
        [ 445, "Затачивание  карандаша", 7.392625],
        [ 446, "Деревообрабатывающая мастерская", 65.697937],
        [ 447, "Загрузка тостера", 2.142000],
        [ 448, "Жестокая стрижка", 20.009750],
        [ 449, "Заворачивают гайку", 15.777938],
        [ 450, "Газосварка", 64.208938],
        [ 451, "Дверь -ширма открывается", 6.739562],
        [ 452, "В лаборатории", 43.049750],
        [ 453, "Готовый хлеб выскакивает из тостера", 1.541187],
        [ 454, "Дверь -ширма закрывается", 6.321625],
        [ 455, "Выигрыш в автомате - выплата денег", 15.072625],
        [ 456, "Самолёты", 177.763250],
        [ 457, "Автоматические двери в гараж открываются", 15.751812],
        [ 458, "Бормашина", 15.046500],
        [ 459, "Автоматические двери в гараж закрываются", 12.068562],
        [ 460, "Автозаправочная станция -воздушный шланг", 10.736313],
        [ 461, "Шум реактивного двигателя", 36.466938],
        [ 462, "Радиообмен", 65.306062],
        [ 463, "Самолёт", 31.033438],
        [ 464, "Реактивный самолет пролетает и приземляется", 21.498750],
        [ 465, "Пролетающий реактивный самолет", 21.655500],
        [ 466, "Реактивный самолет ,пролетающий справа  налево", 21.133062],
        [ 467, "Пролетающий военный реактивный самолет", 9.168938],
        [ 468, "Пролетающий одновинтовой самолет", 11.990187],
        [ 469, "Пролетающий пассажирский самолет", 16.013063],
        [ 470, "Пролетающий  двухвинтовой самолет", 28.003250],
        [ 471, "Пролетающий вертолет 2", 21.054688],
        [ 472, "Пролетающий вертолет", 17.711000],
        [ 473, "Пролетающий  винтовой самолет  2", 63.085687],
        [ 474, "Пролетающий  военный реактивный самолет", 25.991812],
        [ 475, "Пролетающий вертолет  2", 25.991812],
        [ 476, "Пролетающий  винтовой самолет", 10.031000],
        [ 477, "Прибытие вертолета и посадка", 92.499563],
        [ 478, "Приземление самолета - визг шасси", 18.834250],
        [ 479, "Приземление  реактивного самолета", 35.343625],
        [ 480, "Приземление  вертолета", 40.071813],
        [ 481, "Приземление   винтового  самолета", 22.047313],
        [ 482, "Полет вертолета", 47.020375],
        [ 483, "Посадка реактивного самолета", 33.541187],
        [ 484, "Посадка самолета и визг шасси", 16.404875],
        [ 485, "Полет в вертолете", 39.862813],
        [ 486, "Инструктаж перед посадкой (англ.яз)", 71.053062],
        [ 487, "Инструктаж перед полетом (англ.яз)", 70.086500],
        [ 488, "Винтовой самолет запускает двигатели", 65.358313],
        [ 489, "Взлет самолета", 23.771375],
        [ 490, "Взлетающий двухвинтовой самолет", 21.995062],
        [ 491, "Вертолет", 107.990187],
        [ 492, "Взлет самолета 2", 17.502000],
        [ 493, "Взлет реактивного самолета 3", 20.114250],
        [ 494, "Взлет реактивного самолета", 18.964875],
        [ 495, "Взлет реактивного самолета 2", 26.906062],
        [ 496, "Взлет винтового самолета", 14.915875],
        [ 497, "Взлет пассажирского самолета", 24.032625],
        [ 498, "Взлет вертолета", 30.066938],
        [ 499, "Взлет винтового самолета 2", 21.028562],
        [ 500, "Вертолет запускается и взлетает", 89.782813],
        [ 501, "Вертолет снижается и садится", 66.037500],
        [ 502, "Вертолет приземляется", 58.984437],
        [ 503, "В реактивном самолете,объявления экипажа", 100.884875],
        [ 504, "Вертолет запускается и взлетает ( восприятие из вертолета )", 63.973875],
        [ 505, "В винтовом самолете", 64.992625],
        [ 506, "В полете  2.Пролетающий Конкорд  3. Авиакатастрофа1,2", 52.035875],
        [ 507, "Авиакатастрофа и пожар", 43.990187],
        [ 508, "Футбол- атмосфера на стадионе", 63.555875],
        [ 509, "Фейерверк", 66.429375],
        [ 510, "Фехтование- общая атмосфера во время матча", 61.492188],
        [ 511, "Удары с лета в теннисе", 60.682437],
        [ 512, "Упражнения с тяжестями", 33.097125],
        [ 513, "Толпа на скачках", 61.335500],
        [ 514, "Сквош - общая атмосфера во время игры", 62.537125],
        [ 515, "Рыбалка(море) - заброс,вытаскивают рыбу", 63.477500],
        [ 516, "Рыбалка(река)  - заброс,наматывание лески", 66.115875],
        [ 517, "Раздача карт", 33.515062],
        [ 518, "Ребенок плывет", 32.757500],
        [ 519, "Прыгалка", 30.040812],
        [ 520, "Пул - шары разбивают", 12.042438],
        [ 521, "Пул- комбинированный удар", 7.627750],
        [ 522, "Плавание в бассейне", 62.406500],
        [ 523, "Прогулка в лодке ,гребля", 61.596688],
        [ 524, "На американских горках", 68.075063],
        [ 525, "Перетасовка карт 2", 9.090563],
        [ 526, "Перетасовка карт", 4.884875],
        [ 527, "Карнавал", 62.955062],
        [ 528, "Картинг - общая атмосфера", 61.283250],
        [ 529, "Ныряют и уплывают", 14.654688],
        [ 530, "Игравой автомат", 61.857937],
        [ 531, "Карате - крики, удары", 21.028562],
        [ 532, "Игра в боулинг - общая атмосфера", 64.391813],
        [ 533, "Игра в боулинг – общая атмосфера", 62.537125],
        [ 534, "Залы видеоигр - общая атмосфера", 61.962438],
        [ 535, "Игра в Patchinco", 34.377125],
        [ 536, "Зал видеоигр - общая атмосфера", 61.648938],
        [ 537, "Дети играют(англ.яз.)", 62.746063],
        [ 538, "Grand Prix -атмосфера на стадионе , комментарии", 65.306062],
        [ 539, "Боксирование с “грушей”", 49.658750],
        [ 540, "Боулиг - удар", 7.183625],
        [ 541, "Боулинг - мяч катится", 10.501188],
        [ 542, "Бег- справа налево", 11.728938],
        [ 543, "Бейсбол - удар алюминиевой битой по мячу", 4.597500],
        [ 544, "Электронный сигнал радара", 103.993437],
        [ 545, "Электронный звук гидролокатора", 35.004063],
        [ 546, "Ящики картотечного шкафа открывают и закрывают", 13.792625],
        [ 547, "Электронный будильник", 11.937938],
        [ 548, "Часы с кукушкой бьют 12 часов", 14.994250],
        [ 549, "Чашку ставят на блюдце", 2.037500],
        [ 550, "Шипение-огонь", 2.481625],
        [ 551, "Школьный звонок звонит несколько раз", 9.848125],
        [ 552, "Щелчок выключателя", 3.918313],
        [ 553, "Щелчок зажигалки", 5.616312],
        [ 554, "Щелчок пальцами", 2.220375],
        [ 555, "Тиканье секундомера", 63.582000],
        [ 556, "Удар деревянной биты по мячу", 6.582813],
        [ 557, "Удар молотка в суде", 4.336313],
        [ 558, "Хлыст", 6.034250],
        [ 559, "Хруст картофельных чипсов", 14.367313],
        [ 560, "Хруст сломанной ветки", 2.011375],
        [ 561, "Треск", 9.743625],
        [ 562, "Трубку вешают -версия1", 4.806500],
        [ 563, "Удар алюминиевой  биты по мячу", 6.844063],
        [ 564, "Тиканье будильника", 61.544437],
        [ 565, "Тиканье нескольких часов  2", 61.518313],
        [ 566, "Счет монет", 17.162437],
        [ 567, "Телефон звонит 3 раза и трубку поднимают", 16.770563],
        [ 568, "Телефон- поднимают трубку", 2.899563],
        [ 569, "Телефон-набирают номер -занято", 11.624438],
        [ 570, "Стекло", 4.362437],
        [ 571, "Стрельба из лука -стрела попадает в мишень", 6.582813],
        [ 572, "Стук в дверь - дверь открывается, стучавший входит", 9.377937],
        [ 573, "Стул, царапающий пол", 5.485688],
        [ 574, "Скачущий мяч", 65.828563],
        [ 575, "Смена кадров", 13.348562],
        [ 576, "Содовую наливают в стакан", 10.057125],
        [ 577, "Скрепление степлером", 5.537937],
        [ 578, "Скрип костей", 18.050562],
        [ 579, "Скрип кроссовок по полу", 2.063625],
        [ 580, "Сирена", 56.999125],
        [ 581, "Скачущий мяч удаляется", 7.497125],
        [ 582, "Сирена  2", 12.068562],
        [ 583, "Скачущий мяч  удаляется", 11.728938],
        [ 584, "Роняют поднос с тарелками", 8.385250],
        [ 585, "Свист тростника в воздухе", 5.328938],
        [ 586, "Свисток судьи", 7.000812],
        [ 587, "Сигнал SOS, передаваемой по азбуке Морзе", 11.990187],
        [ 588, "Сигнал в телевизионной игре 2", 5.773062],
        [ 589, "Сигнал в телевизионной игре", 6.400000],
        [ 590, "Сильное шипение", 7.680000],
        [ 591, "Работа принтера", 33.462812],
        [ 592, "Ракета", 19.095500],
        [ 593, "Расстегивание молнии", 4.728125],
        [ 594, "Роняют  поднос с тарелками", 5.407312],
        [ 595, "Пробка, вылетающая из бутылки с шампанским", 7.157500],
        [ 596, "Пробка, вылетающая из бутылки", 4.780375],
        [ 597, "Пробку вытаскивают ( с эхом)", 6.922438],
        [ 598, "Пьют через соломинку, глоток", 4.075062],
        [ 599, "Разбивают оконное стекло", 9.743625],
        [ 600, "Напиток ведьм", 64.078313],
        [ 601, "Открывают банку содовой", 35.761625],
        [ 602, "Пробка вылетает из бутылки шампанского", 6.478313],
        [ 603, "Пробка выскакивает из бутылки шампанского", 4.519125],
        [ 604, "Пробка, вылетающая из бутылки 2", 1.358313],
        [ 605, "Неправильный ответ", 7.053063],
        [ 606, "Ногти по школьной доске", 6.373875],
        [ 607, "Кубики льда в стакане-2", 5.720813],
        [ 608, "Лопается воздушный шарик - эхо", 3.134688],
        [ 609, "Молния застегивается", 5.407312],
        [ 610, "Молния расстегивается", 5.250563],
        [ 611, "Монеты кидают на стол", 10.814687],
        [ 612, "Надувают воздушный шарик", 11.102000],
        [ 613, "Кнопочный телефон", 32.679125],
        [ 614, "Колокол пожарной тревоги", 20.453875],
        [ 615, "Колотушка", 12.486500],
        [ 616, "Кубики льда в ведерке", 4.545250],
        [ 617, "Кубики льда в стакане-1", 7.497125],
        [ 618, "Капли – 2", 57.051375],
        [ 619, "Колдовское зелье", 18.991000],
        [ 620, "Звук  гидролокатора восприятие из подводной лодки", 156.995875],
        [ 621, "Клавиатура компьютера", 17.188562],
        [ 622, "Капли  - 1", 66.037500],
        [ 623, "Звук хлыста", 7.444875],
        [ 624, "Зуммер домофона", 4.493062],
        [ 625, "Капающая вода", 23.327313],
        [ 626, "Звук капающей воды с эхом", 32.574688],
        [ 627, "Звонок при входе на бензоколонку - 2", 6.739562],
        [ 628, "Звук бьющегося стакана", 6.034250],
        [ 629, "Звук затвора 35 мм фотоаппарата", 7.392625],
        [ 630, "Звон стаканов в тосте 2", 11.102000],
        [ 631, "Звон стаканов в тосте", 3.186937],
        [ 632, "Звонок велосипеда", 4.414688],
        [ 633, "Звонок из таксофона", 22.282438],
        [ 634, "Звонок кассового аппарата", 6.974687],
        [ 635, "Звонок при входе на бензоколонку – 1", 2.272625],
        [ 636, "Звон монет ,брошенных на стол", 8.045688],
        [ 637, "Звон монет", 16.195875],
        [ 638, "Звон стакана в тосте", 5.746937],
        [ 639, "Звон стаканов в тосте  2", 12.564875],
        [ 640, "Городские часы бьют 12 часов", 58.305250],
        [ 641, "Дребезжащие на подносе стаканы", 15.595062],
        [ 642, "Застегивание молнии", 4.571375],
        [ 643, "Затачивание карандаша", 6.269375],
        [ 644, "Звон большого хрустального стакана", 5.276688],
        [ 645, "Звон маленького хрустального стакана", 5.982000],
        [ 646, "Грязь с бетона собирают в совок", 19.853063],
        [ 647, "Гудок легковой автомашины -один", 5.564063],
        [ 648, "Гремящие цепи", 20.271000],
        [ 649, "Вспышка заряжается и срабатывает", 14.942000],
        [ 650, "Газированная вода", 38.086500],
        [ 651, "Гидролокатор подводной лодки", 7.888937],
        [ 652, "Воздушные пузырьки в воде", 16.509375],
        [ 653, "Воздушный шарик лопается", 5.067750],
        [ 654, "Воздушный шарик надувают", 11.807313],
        [ 655, "Воздушный шарик отпускают", 7.758312],
        [ 656, "Всплеск воды", 9.299563],
        [ 657, "Большие пузыри в воде", 36.205688],
        [ 658, "В пещере капает вода", 37.328937],
        [ 659, "Велосипедный звонок", 7.915063],
        [ 660, "Воздушный шарик лопается с эхом", 6.582813],
        [ 661, "Банку содовой открывают ,воду наливают", 35.787750],
        [ 662, "Банку закрывают крышкой  2", 5.407312],
        [ 663, "Банку закрывают крышкой", 3.604875],
        [ 664, "Бег  по бетонной дороге", 7.810562],
        [ 665, "Большая дверь закрывается , эхо", 4.963250],
        [ 666, "Cообщение на азбуке Морзе", 32.626937],
        [ 667, "Автоматический привод фотоаппарата", 7.366500],
        [ 668, "Аэрозоль - непродолжительное распыление", 3.004063],
        [ 669, "Ядерный взрыв", 23.013875],
        [ 670, "Танки", 22.987750],
        [ 671, "Узи пулемет -короткие и средние очереди", 39.993437],
        [ 672, "Стрельба из станкового пулемета", 25.991812],
        [ 673, "Стрельба из танка", 15.986937],
        [ 674, "Три  выстрела из крупнокалиберного пистолета", 4.728125],
        [ 675, "Стрельба из пулемета AK 47", 48.979563],
        [ 676, "Стрельба из пулемета M 60 - длинные очереди", 26.984437],
        [ 677, "Стрельба из пулемета времен I мировой войны", 12.982812],
        [ 678, "Стрельба из револьвера на улице с эхом", 17.998313],
        [ 679, "Стрельба из пистолета на улице -15 выстрелов", 38.974688],
        [ 680, "Стрельба из крупнокалиберного пистолета на улице", 64.026062],
        [ 681, "Стрельба из немецкой винтовки времен II мировой войны", 21.995062],
        [ 682, "Стрельба из нескольких винтовок М1", 12.956687],
        [ 683, "Стрельба из винтовки 30-30 на улице с эхом - 3 выстрела", 21.968937],
        [ 684, "Стрельба из винтовки - выстрел, перезарядка, снова выстрел", 28.995875],
        [ 685, "Стрельба из винтовки- 3 приказа стрелять - салют 3 раза", 38.008125],
        [ 686, "Стрельба из 50-ти калиберного пулеметы- короткие очереди", 38.034250],
        [ 687, "Стрельба из автоматической винтовки  на улице", 19.017125],
        [ 688, "Стрельба из 40- мм двустволки", 32.940375],
        [ 689, "Стрельба из 45-калиберного пистолета", 5.982000],
        [ 690, "Стрельба из 37-мм противотанкового орудия , 5 выстрелов", 22.987750],
        [ 691, "Стрельба из 40 -мм  корабельного зенитного орудия", 35.996688],
        [ 692, "Стрельба и огонь из пулемета М 60", 35.944437],
        [ 693, "Стрельба из 16 дюйм. корабельного орудия   , выстрелов", 39.941188],
        [ 694, "Стрельба из 22- калиберного оружия  - 6 выстрелов", 6.974687],
        [ 695, "Стрельба из 38-калиберного полуавтоматического  пистолета", 5.982000],
        [ 696, "Сражение -XVIII -XIX век", 85.106938],
        [ 697, "Стрельба  из армейской винтовки М 16", 47.986938],
        [ 698, "Сражение -ХХ  век", 61.048125],
        [ 699, "Снаряд 75 калибра разрывается", 14.001625],
        [ 700, "Рикошеты и огонь из автомата", 33.018750],
        [ 701, "Ряд взрывов", 19.905250],
        [ 702, "Свист падающего метательного снаряда - взрыв", 7.993438],
        [ 703, "Слабый взрыв с падающими осколками", 11.180375],
        [ 704, "Пушечная  стрельба- 10 длинных выстрелов", 40.986062],
        [ 705, "Рикошет от скалы", 27.924875],
        [ 706, "Пулеметная стрельба", 10.997500],
        [ 707, "Пулеметный обстрел", 11.206500],
        [ 708, "Пушка", 4.257937],
        [ 709, "Поле боя -стрельба из пистолетов", 86.961625],
        [ 710, "Пролетающий артиллерийский снаряд - взрыв", 8.960000],
        [ 711, "Пулеметная очередь - ответный огонь", 11.180375],
        [ 712, "Пулеметная очередь- ответный огонь", 11.363250],
        [ 713, "Пулеметная очередь", 7.523250],
        [ 714, "Приказ стрелять из пушки", 14.994250],
        [ 715, "Перестрелка", 12.094688],
        [ 716, "Приближение и взрыв снаряда из 105- мм гаубицы - 2 раза", 22.021187],
        [ 717, "Огнестрельная битва - эхо нескольких винтовок в каньоне", 66.977937],
        [ 718, "Перестрелка, одного убивают", 15.986937],
        [ 719, "Пистолет - один выстрел", 4.101187],
        [ 720, "Пистолетные выстрелы", 5.851375],
        [ 721, "Один выстрел из крупнокалиберного пистолета", 4.728125],
        [ 722, "Перестрелка ( с транспортом)", 14.393438],
        [ 723, "Перестрелка из машины", 7.732188],
        [ 724, "Воздушный  налёт", 154.984438],
        [ 725, "Несколько пушечных выстрелов , некоторые вдалеке", 32.000000],
        [ 726, "Мощный взрыв динамита", 8.960000],
        [ 727, "Небольшой снаряд", 9.038312],
        [ 728, "Несколько авт . винтовок браунинг стреляют вместе", 9.978750],
        [ 729, "Звук пули авт . винтовки браунинг", 13.975500],
        [ 730, "Множество взрывов", 19.774688],
        [ 731, "Забивание шомпола в cтаринную пушку ( 3 раза)", 23.040000],
        [ 732, "Зарядка револьвера 25 калибра", 5.720813],
        [ 733, "Выстрел из миномета 81 калибра", 9.978750],
        [ 734, "Выстрел", 6.086500],
        [ 735, "Длинный рикошет", 7.105250],
        [ 736, "Винтовка М 14 - несколько выстрелов", 7.758312],
        [ 737, "Выстрел из винчестера , перезарядка между выстрелами - 5 раз", 20.950187],
        [ 738, "Взрыв глубинной бомбы - шум воды", 37.982000],
        [ 739, "Взрыв с падающими осколками", 8.019562],
        [ 740, "Взрыв средней мощности", 9.900375],
        [ 741, "Взрыв", 10.997500],
        [ 742, "Винтовка - один выстрел", 7.183625],
        [ 743, "Винтовка М 14 - один выстрел", 4.493062],
        [ 744, "Взрыв и падающие осколки 2", 9.743625],
        [ 745, "Взрыв и падающие осколки", 8.306938],
        [ 746, "Взрыв ручной гранаты - падают комки  земли", 6.974687],
        [ 747, "6 выстрелов из винтовки М-1", 16.013063],
        [ 748, "Автоматные рикошеты 1", 6.948562],
        [ 749, "Автоматные рикошеты 2", 9.978750],
        [ 750, "Взвод винтовки", 7.262000],
        [ 751, "Судно на воздушной подушке", 49.893875],
        [ 752, "3 выстрела из 45 калибра", 6.974687],
        [ 753, "3 выстрела из винтовки", 6.243250],
        [ 754, "Моторная лодка заводится- двигатель набирает обороты - отключается", 43.128125],
        [ 755, "Подводная лодка- звук гидролокатора", 38.426063],
        [ 756, "Проходящий паром", 31.033438],
        [ 757, "Моторная лодка ,набирающая скорость", 65.018750],
        [ 758, "Моторная лодка ,движущаяся с постоянной скоростью", 49.031813],
        [ 759, "Корабль в море", 48.039125],
        [ 760, "Катер- заводится и отчаливает", 32.548562],
        [ 761, "Баржа, движущаяся на медленной скорости", 65.044875],
        [ 762, "Катер  -проплывает на большой скорости", 20.532187],
        [ 763, "2 корабельных гудка", 14.001625],
        [ 764, "Скопище рожков", 42.004875],
        [ 765, "Труба насмехается", 3.343625],
        [ 766, "Труба- ржание", 7.601625],
        [ 767, "Флексатон - нисходящий ряд", 3.500375],
        [ 768, "Флексатон -восходящий ряд", 3.683250],
        [ 769, "Привидения- электронная версия", 65.149375],
        [ 770, "Свист ветра", 9.012187],
        [ 771, "Свист", 5.328938],
        [ 772, "Придурок", 5.041625],
        [ 773, "Прикольный рожок", 7.053063],
        [ 774, "Свист 2", 7.026938],
        [ 775, "Оркестровое пение птиц", 6.060375],
        [ 776, "Праздничные рожки", 33.306062],
        [ 777, "Праздничный рожок", 6.765688],
        [ 778, "Оркестр настраивается  2", 62.406500],
        [ 779, "Оркестр настраивается", 62.406500],
        [ 780, "Настройка дудочки- женщина собирается петь", 7.026938],
        [ 781, "Нисходящее глиссандо на арфе 2", 9.691375],
        [ 782, "Нисходящее глиссандо на арфе", 11.781187],
        [ 783, "Нисходящий свист", 7.053063],
        [ 784, "Волынки", 45.975500],
        [ 785, "Восходящее глиссандо на арфе", 8.045688],
        [ 786, "Гитара- перебор открытых струн", 10.893063],
        [ 787, "Имитация лошадиного ржания на трубе", 7.000812],
        [ 788, "Ксилофон ' Loneranger”", 9.038312],
        [ 789, "Волынка - шотландская мелодия", 63.164062],
        [ 790, "Восклицание", 6.034250],
        [ 791, "Восходящее глиссандо на арфе 2", 9.717500],
        [ 792, "Военный оркестр на параде", 65.985250],
        [ 793, "Арфа - нисходящее глиссандо", 10.344438],
        [ 794, "Арфа -восходящее глиссандо", 9.064438],
        [ 795, "Безумное пианино", 11.049750],
        [ 796, "Быстрый восходящий свист", 6.295500],
        [ 797, "Быстрый нисходящий свист", 1.123250],
        [ 798, "1.Плохая игра на скрипке  20 - 2. Сигнал “отбой” 09 - 3.Орган из “мыльной оперы” 1,2", 60.839125],
        [ 799, "5 сим. Бетховена- начало", 9.247312],
        [ 800, "Арфа - “Добро  пожаловать на небеса “", 9.038312],
        [ 801, "Столярная мастерская", 62.432625],
        [ 802, "Рыбалка на тихом озере", 46.994250],
        [ 803, "Электрические искры", 8.019562],
        [ 804, "Потрескивание огня", 47.046500],
        [ 805, "Рубка мачете", 13.035063],
        [ 806, "Полицейская рация", 25.913438],
        [ 807, "Рубка дерева топором", 21.054688],
        [ 808, "Пожарная тревога", 20.767313],
        [ 809, "Запуск ракеты с отсчетом", 62.876688],
        [ 810, "Нож Боло -нарезка", 44.042438],
        [ 811, "Падающее дерево в лесу", 10.057125],
        [ 812, "Кресло- качалка матушки Бейтс", 24.032625],
        [ 813, "Закрепление прически лаком", 22.125687],
        [ 814, "Казнь на электрическом стуле", 20.009750],
        [ 815, "Дерево рубят и оно падает", 17.371375],
        [ 816, "Драка двух мужчин -удары, звуки борьбы", 14.994250],
        [ 817, "Вскапывание земли в саду", 60.943625],
        [ 818, "Высокое напряжение", 44.068562],
        [ 819, "1.Бушующий огонь и вой ветра 112  - 2. Землетрясение  3. Вулкан  4. Лава", 192.862000],
        [ 820, "Возле доков - общая атмосфера", 63.373062],
        [ 821, "Бушующий огонь", 41.038312],
        [ 822, "1. Занавеска  04  -  2. Кандалы на ногах 2  -  3. Волочение кандалов с гирей 08", 69.851375],
        [ 823, "3 телефонных звонка - трубку поднимают", 21.185250],
        [ 824, "Набор номера на дисковом телефоне", 17.057938],
        [ 825, "Трубку вешают- версия 2", 6.269375],
        [ 826, "Швыряют телефонную трубку", 7.026938],
        [ 827, "1 звонок - трубку поднимают", 7.000812],
        [ 828, "Смех  группы мужчин", 58.044063],
        [ 829, "Толпа, охваченная паникой", 35.944437],
        [ 830, "Публика на вечеринке", 68.989375],
        [ 831, "Радостное одобрительное восклицание небольшой группы", 6.608938],
        [ 832, "Реация на пропущенную лунку у зрителей гольфа", 8.202438],
        [ 833, "Пьяные", 36.048938],
        [ 834, "Крики  толпы", 48.039125],
        [ 835, "Одобрительные детские возгласы", 8.019562],
        [ 836, "Группа восклицает", 8.045688],
        [ 837, "Группа детей", 8.045688],
        [ 838, "Легкий  смех в аудитории", 16.718312],
        [ 839, "Возглас удовлетворения толпы", 2.063625],
        [ 840, "Возглас удовлетворенной толпы", 6.661187],
        [ 841, "Возгласы небольшой толпы", 14.942000],
        [ 842, "Воодушевленные мужчины после веселого разговора", 9.012187],
        [ 843, "Агрессивная  толпа", 62.615500],
        [ 844, "Возглас отвращения в толпе", 6.635063],
        [ 845, "Возглас отвращения толпы", 2.560000],
        [ 846, "Возглас разочарования толпы", 2.481625],
        [ 847, "Возглас разочарованной толпы", 6.269375],
        [ 848, "Возглас удивления ,поражения", 7.026938],
        [ 849, "Агрессивная компания", 55.040000],
        [ 850, "Вздох удивления небольшой группы", 7.471000],
        [ 851, "'Right on' и ответные реплики прихожан", 8.071813],
        [ 852, "Храп монстра", 35.004063],
        [ 853, "“Сюрприз” на вечеринке", 10.448937],
        [ 854, "Тарзан - крик джунглей", 6.217125],
        [ 855, "Трещотка", 8.385250],
        [ 856, "Стрельба из лазерного  оружия  2", 8.986062],
        [ 857, "Стрельба из лазерного  оружия", 19.983625],
        [ 858, "Судья объявляет “ вы выходите из игры”", 6.034250],
        [ 859, "Тирольский призыв", 10.893063],
        [ 860, "Смех гуманоида", 25.051375],
        [ 861, "Собачий смех", 14.027750],
        [ 862, "Смех тропической птицы", 11.049750],
        [ 863, "Скрипучая кровать", 35.030187],
        [ 864, "Смех бурундука", 15.046500],
        [ 865, "Свист ракеты - выстрел из лазерного оружия  2", 10.997500],
        [ 866, "Сигнал машины в виде мычания коровы", 18.050562],
        [ 867, "Мужчина, храпящий во время веселого сна", 32.078312],
        [ 868, "Пробка  пищит и вылетает", 8.045688],
        [ 869, "Продавец кричит -“ хотдоги “", 12.042438],
        [ 870, "Свист ракеты - выстрел из лазерного оружия  1", 10.997500],
        [ 871, "Мычание монстра", 13.008938],
        [ 872, "Кондуктор дает сигнал к отправлению", 6.060375],
        [ 873, "Короткая  отрыжка", 5.198313],
        [ 874, "Космический смертельный луч", 14.001625],
        [ 875, "Молния", 6.008125],
        [ 876, "Мужская отрыжка", 7.026938],
        [ 877, "Дурацкое печатание", 22.047313],
        [ 878, "Комический рикошет- 9 выстрелов", 25.991812],
        [ 879, "В шланге кончилась вода", 33.044875],
        [ 880, "Гудок", 3.291375],
        [ 881, "Детская отрыжка", 5.041625],
        [ 882, "Звук отрыжки", 1.384437],
        [ 883, "В кране кончилась вода", 11.049750],
        [ 884, "Ворчание злого гнома", 9.012187],
        [ 885, "kazoo", 6.034250],
        [ 886, "Бомба с часовым механизмом", 13.035063],
        [ 887, "“Крута-а-ая”", 10.031000],
        [ 888, "“Кто это сделал", 7.079125],
        [ 889, "Поездка в метро", 67.030188],
        [ 890, "Поезд в метро прибывает на станцию и уезжает", 59.010562],
        [ 891, "Поезд проезжает переезд", 67.030188],
        [ 892, "Паровоз трогается", 41.012188],
        [ 893, "На железнодорожной станции", 51.983625],
        [ 894, "В поезде", 60.029375],
        [ 895, "Паравоз выпускает пар", 8.045688],
        [ 896, "Шум между вагонами движущегося поезда", 64.078313],
        [ 897, "Станция метро", 4.284063],
        [ 899, "Проходящий поезд", 65.993250],
        [ 903, "Проезжающий трамвай", 13.113437],
        [ 904, "Проезжающий поезд", 51.069375],
        [ 905, "Проезжающий поезд в метро", 22.047313],
        [ 906, "Поездка на фуникулёре", 71.105250],
        [ 907, "Пригородный поезд прибывает и остановливается , а затем отходит", 49.031813],
        [ 908, "Бар с фортепьяно", 63.529750],
        [ 909, "Аэропорт- зал прибытия", 66.716688],
        [ 910, "Аэропорт- проверка билетов", 64.417937],
        [ 911, "Автомобильная пробка , сигналят", 23.797500],
        [ 912, "Строительная площадка", 63.137937],
        [ 913, "Телетайпы в информационном отделе", 65.201625],
        [ 914, "Публика на параде", 61.936312],
        [ 915, "Рынок- общая атмосфера", 62.537125],
        [ 916, "Пешеходы в деловой части города", 62.824437],
        [ 917, "Пробка , продолжительные сигналы", 45.035063],
        [ 918, "Пешеходная аллея", 62.380375],
        [ 919, "Парк игр и развлечений", 67.004063],
        [ 920, "Офис- общая атмосфера", 63.164062],
        [ 921, "На открытом воздухе", 43.990187],
        [ 922, "На карнавале", 66.037500],
        [ 923, "Магазин теле-, радиоаппаратуры", 64.444063],
        [ 924, "Контроль на выходе из супермаркета", 61.361625],
        [ 925, "Дождь с грозой в городе", 62.641625],
        [ 926, "Городское движение", 65.854687],
        [ 927, "В кафе", 63.738750],
        [ 928, "Городское движение 2", 44.068562],
        [ 929, "В аэропорту", 66.115875],
        [ 930, "В информационном отделе", 66.716688],
        [ 931, "Стук в дверь - дверь открывается", 13.766500],
        [ 932, "Стук в дверь 2", 7.079125],
        [ 933, "Стрижка волос", 37.537937],
        [ 934, "Струя воды", 24.058750],
        [ 935, "Спуск по лестнице", 10.448937],
        [ 936, "Слив в туалете 2", 11.833438],
        [ 937, "Слив в туалете", 19.330562],
        [ 938, "Спичку зажигают", 7.366500],
        [ 939, "Руки вытирают полотенцем", 7.653875],
        [ 940, "Сильное шипение на сковороде", 10.579562],
        [ 941, "Скрип деревянных ворот", 20.035875],
        [ 942, "Раковину наполняют водой", 35.578750],
        [ 943, "Раскалывание яиц", 14.706937],
        [ 944, "Рвут материал", 7.784438],
        [ 945, "Радио- настойка на FM", 13.688125],
        [ 946, "Размешивание в чашке", 10.527312],
        [ 947, "Просматривание газеты", 19.304437],
        [ 948, "Пьют из питьевого  фонтанчика", 12.695500],
        [ 949, "Радио - настройка на АМ", 13.374688],
        [ 950, "Поливка из шланга", 63.843250],
        [ 951, "Помехи", 35.265250],
        [ 952, "Потягивание кофе", 8.542000],
        [ 953, "Пол моют щеткой", 31.947750],
        [ 954, "Поджаривание бекона", 63.190188],
        [ 955, "Подъем по лестнице", 15.804063],
        [ 956, "Подметание пола", 36.545250],
        [ 957, "Поднос с дребезжащими стаканами", 14.968125],
        [ 958, "Пишут на школьной доске 2", 36.362438],
        [ 959, "Пишут на школьной доске", 35.735500],
        [ 960, "Питьевой фонтанчик включают и выключают", 13.113437],
        [ 961, "Печатание письма", 66.272625],
        [ 962, "Письмо открывают", 15.203250],
        [ 963, "Письмо сминают и выбрасывают 2", 9.900375],
        [ 964, "Письмо сминают и выбрасывают", 6.844063],
        [ 965, "Пиление ручной пилой", 16.117500],
        [ 966, "Перетасовка и раздача карт", 39.288125],
        [ 967, "Натирание моркови на терке", 25.991812],
        [ 968, "Открывется скрипучая дверь", 19.435063],
        [ 969, "Нарезка овощей", 28.813063],
        [ 970, "Книга- перелистывание страниц", 60.786937],
        [ 971, "Намазывание масла на тост", 14.132188],
        [ 972, "Конверт открывают", 16.613875],
        [ 973, "Легкое шипение на сковороде", 5.537937],
        [ 974, "Мытье рук в раковине", 13.087312],
        [ 975, "Звон посуды", 64.444063],
        [ 976, "Игла проигрывателя царапает пластинку", 7.392625],
        [ 977, "Затачивание ножа 3", 29.048125],
        [ 978, "Звонки в дверь", 10.971375],
        [ 979, "Затачивание ножа 1", 13.035063],
        [ 980, "Железные ворота открывают", 7.575500],
        [ 981, "Закрывется скрипучая дверь", 4.571375],
        [ 982, "Засорившийся туалет", 14.027750],
        [ 983, "Затачивание ножа  2", 7.026938],
        [ 984, "В душе-1", 80.117500],
        [ 985, "Дверной звонок звонит несколько раз", 5.982000],
        [ 986, "Дверь закрывается", 6.739562],
        [ 987, "Дверь открывается", 6.034250],
        [ 988, "Железные ворота закрывают", 7.026938],
        [ 989, "Гвозди забивают в дерево", 20.035875],
        [ 990, "Дверная ручка", 6.086500],
        [ 991, "Газету рвут", 4.806500],
        [ 992, "В стакан наливают воду", 9.168938],
        [ 993, "Воду выпускают из раковины", 10.370563],
        [ 994, "Бумагу сминают", 7.653875],
        [ 995, "Бумажный пакет надевают на голову и снимают", 16.169750],
        [ 996, "Быстро рвут материал", 6.373875],
        [ 997, "Бег по бетонной дороге", 9.560812],
        [ 998, "Бумагу рвут ( быстро)", 9.822000],
        [ 999, "Бумагу рвут ( медленно)", 10.475062],
        [1000, "Яйца взбивают в миске", 26.644875],
        [1001, "Щетка падает", 6.060375],
        [1002, "Ящик закрывается со скрипом", 6.034250],
        [1003, "Ящик открывается со скрипом", 5.590188],
        [1004, "Чистка зубов 2", 24.032625],
        [1005, "Чистка зубов", 22.935500],
        [1006, "Шаги по деревянному покрытию", 17.110187],
        [1007, "Царапанье в дверь", 34.011375],
        [1008, "Стук в дверь", 8.515875],
        [1009, "Тревога по радио", 14.602437],
        [1010, "Хлопают дверью", 5.407312],
        [1011, "Испуганное дыхание", 69.041625],
        [1012, "Биение сердца", 62.563250],
        [1013, "Женщина икает", 9.038312],
        [1014, "Биение сердца 2", 66.089750],
        [1015, "Фырканье и чавканье", 39.026938],
        [1016, "Чихание", 8.228562],
        [1017, "Тяжелое дыхание", 33.410563],
        [1018, "Урчание в желудке", 6.034250],
        [1019, "Отрыжка", 5.955875],
        [1020, "Рассройство желудка", 7.026938],
        [1021, "Тяжёлое дыхание", 16.065250],
        [1022, "Мужчина очень шумно сморкается", 16.039125],
        [1023, "Мужчина сморкается", 15.986937],
        [1024, "Мужчина чихает", 17.031812],
        [1025, "Мужской храп", 34.037500],
        [1026, "Мужчина зевает", 11.075875],
        [1027, "Лизание", 16.091375],
        [1028, "Мужской кашель 2", 13.008938],
        [1029, "Мужской кашель", 10.814687],
        [1030, "Короткая отрыжка", 5.642437],
        [1031, "Автокатастрофа, крик", 13.766500],
        [1032, "Автомобиль  заводится , двигатель набирает обороты", 19.513438],
        [1033, "Автомобиль - открывают капот", 4.048938],
        [1034, "Автобус приезжает и останавливается, затем трогается", 34.977937],
        [1035, "Автокатастрофа, “цепная реакция”", 23.092188],
        [1036, "Авария", 9.038312],
        [1037, "Холостой ход спортивного автомобиля", 48.013063],
        [1038, "“Скорая” проезжает с сиреной", 18.964875],
        [1039, "Шорох колес проезжающего автомобиля", 16.091375],
        [1040, "Холостой ход автомобиля", 59.036687],
        [1041, "Холостой ход гоночного автомобиля", 17.031812],
        [1042, "Холостой ход  старинного автомобиля", 45.035063],
        [1043, "Формула 1", 27.010563],
        [1044, "Транспорт , двигающийся на средней скорости", 66.011375],
        [1045, "У скоростного автомобиля заканчивается горючее", 11.572188],
        [1046, "Формула 1 - автомобиль проносится мимо", 10.083250],
        [1047, "Транспорт , двигающийся на большой  скорости", 69.067750],
        [1048, "таринный автомобиль уезжает и возвращается", 46.080000],
        [1049, "Скоростной автомобиль трогается и останавливается", 20.375500],
        [1050, "Спортивный автомобиль заводится и уезжает", 12.068562],
        [1051, "Спортивный автомобиль приближается и останавливается", 11.075875],
        [1052, "Скоростной автомобиль заводится и работает на холостом ходу", 35.474250],
        [1053, "Скоростной автомобиль на холостом ходу", 24.293875],
        [1054, "Скоростной автомобиль заводится , горючее заканчивается", 40.254688],
        [1055, "Скоростной автомобиль заводится , горючее заканчивается  2", 21.002437],
        [1056, "Скоростная машина трогается и останавливается", 36.571375],
        [1057, "Скоростной автомобиль - горючее заканчивается- версия 2", 10.370563],
        [1058, "Скоростной автомобиль - скорость 150 mph", 13.113437],
        [1059, "Сигнализация автомобиля", 36.336312],
        [1060, "Сигнал грузовика", 6.034250],
        [1061, "Сильный  занос - серьезная авария", 12.460375],
        [1062, "Проезжающий грузовик", 29.910187],
        [1063, "Сигнал автомобиля 2", 9.038312],
        [1064, "Сигнал автомобиля 3", 4.989375],
        [1065, "Сигнал грузовика - 1 гудок", 10.213875],
        [1066, "Сигнал грузовика - 2 гудка", 8.515875],
        [1067, "Проезжающий спортивный автомобиль", 12.016313],
        [1068, "Сигнал автомобиля 1", 7.026938],
        [1069, "Проезжающие автомобили", 47.020375],
        [1070, "Проезжающий армейский джип", 11.990187],
        [1071, "Проезжающий грузовик сигналит 2", 13.374688],
        [1072, "Проезжающий грузовик сигналит", 9.456313],
        [1073, "Проезжающий автомобиль", 11.075875],
        [1074, "Проезжает полицейская машина с сиреной", 20.897938],
        [1075, "Проезжающая машина сигналит", 7.079125],
        [1076, "Проезжающий автомобиль сигналит", 11.467750],
        [1077, "Полицейская машина трогается с сиреной", 16.143625],
        [1078, "Полиция с сиреной приближается и останавливается", 23.588563],
        [1079, "Мытьё машины, ощущение изнутри", 63.582000],
        [1080, "Полицейская машина  уезжает с сиреной", 35.343625],
        [1081, "Мотоцикл, проезжающий на скорости 100 миль в час", 7.575500],
        [1082, "Несколько автомобильных гудков", 7.888937],
        [1083, "Мотоцикл стоит ,трогается", 62.040813],
        [1084, "Мотоцикл, проезжающий на скорости 55 миль в час 2", 10.866938],
        [1085, "Мотоцикл, проезжающий на скорости 55 миль в час", 7.601625],
        [1086, "Мотоцикл уезжает", 26.044063],
        [1087, "Мотоцикл приближается и останавливается", 30.040812],
        [1088, "Мотоцикл проезжает мимо", 33.018750],
        [1089, "Мотоцикл заводится и отъезжает", 17.214688],
        [1090, "Мотоцикл набирает скорость", 30.066938],
        [1091, "Легковой автомобиль не заводится", 25.704438],
        [1092, "Лобовое столкновение", 13.008938],
        [1093, "Легковой автомобиль- быстрая парковка в гараже", 30.720000],
        [1094, "Звук мотоцикла", 44.068562],
        [1095, "Звук тормозов грузовика", 17.057938],
        [1096, "Легковой автомобиль - двери закрываются на стоянке", 4.728125],
        [1097, "Звук велосипедной цепи", 8.646500],
        [1098, "Звук “дворников”", 29.048125],
        [1099, "Занос на льду", 33.044875],
        [1100, "Двигающийся автобус - восприятие из салона", 65.071000],
        [1101, "Занос и авария", 7.680000],
        [1102, "Занос - визг шин", 9.299563],
        [1103, "Занос автомобиля- визг шин", 4.336313],
        [1104, "Двигатель спортивного автомобиля набирает обороты", 10.031000],
        [1105, "Длинные автомобильные гудки", 8.489750],
        [1106, "Гонки на дороге - восприятие из салона", 74.997500],
        [1107, "Двигатель заводится", 11.049750],
        [1108, "Двигатель набирает обороты", 17.031812],
        [1109, "Двигатель не заводится", 14.027750],
        [1110, "Дверца автомобиля закрывается", 5.746937],
        [1111, "Дверца автомобиля открывается", 6.870187],
        [1112, "Гоночный автомобиль уезжает", 15.020375],
        [1113, "В грузовике", 66.089750],
        [1114, "Большой грузовик приближается,останавливается , а затем уезжает", 41.012188],
        [1115, "Визг колес  восприятие из салона", 7.026938],
        [1116, "Визг колес", 7.026938],
        [1117, "Большой грузовик уезжает", 18.102813],
        [1118, "Автомобильные гонки", 69.093875],
        [1119, "Армейский грузовик на холостом ходу", 50.991000],
        [1120, "Автомобильный гудок", 5.746937],
        [1121, "Автомобиль проносится со скоростью 160 mph", 16.640000],
        [1122, "Автомобиль с севшим аккумулятором", 22.413062],
        [1123, "Автомобильная авария , крик", 10.814687],
        [1124, "Автомобильный гудок- 1 сигнал", 3.239125],
        [1125, "Автомобиль приближается и его заносит", 10.762438],
        [1126, "Автомобиль приближается и останавливается , двигатель выключается", 18.102813],
        [1127, "Автомобиль заносит - авария", 11.102000],
        [1128, "Автомобиль заносит - небольшая авария", 11.415500],
        [1129, "Автомобиль приближается , легкий визг шин", 13.035063],
        [1130, "Автомобиль -закрывают капот", 4.048938],
        [1131, "Автомобиль заводится и уезжает 2", 11.493875],
        [1132, "Автомобиль заводится и уезжает 3", 13.035063],
        [1133, "Автомобиль заводится и уезжает", 14.393438],
        [1134, "Автомобиль , едущий со спущенным колесом", 18.050562],
        [1135, "Автомобиль ,двигающийся со средней скоростью", 40.045687],
        [1136, "Автомобиль быстро приближается и тормозит", 10.945250],
    ];

    public static readonly mp3Names: Map<number, [string, number]> = new Map();

    static initialize() {
        if (ClockController.mp3Names.size === 0) {
            for (const mp3 of ClockController._mp3Names) {
                ClockController.mp3Names.set(mp3[0], [ mp3[1], mp3[2] ]);
            }
        }
    }
}

ClockController.initialize();

