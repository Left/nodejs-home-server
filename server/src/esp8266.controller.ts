import { Relay, Controller, Property, ClassWithId, PropertyImpl, SpanHTMLRenderer, Button, newWritableProperty, SliderHTMLRenderer, StringAndGoRendrer, CheckboxHTMLRenderer, WritableProperty } from "./properties";
import { LcdInformer } from './informer.api';
import { delay, toFixedPoint } from './common.utils';
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
    "brightness": string,          // Brightness [0..100] "0"
    "relay.names": string,         // Relay names, separated by ;
    "hasLedStripe": string,        // Has LED stripe
    "hasPotenciometer"?: string,   // Has potentiometer
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

type AnyMessage = Log | Temp | Hello | IRKey | Weight | ButtonPressed | PingResult | RelayState | LedStripeState | PotentiometerState | AtxState;

export interface ClockControllerEvents {
    onDisconnect: () => void;
    onWeatherChanged: (weather: { temp?: number, humidity?: number, pressure?: number}) => void;
    onWeightReset: () => void;
    onWeightChanged: (weight: number) => void;
    onIRKey: (remoteId: string, keyId: string) => void;
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
        new SpanHTMLRenderer(v => (v === undefined ? "Нет данных" : ((v > 0 ? "+" : "-") + v + "&#8451;"))), 
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
                if (this.devParams["hasPWMOnD0"] === 'true') {
                    if (this.d3PWM && this.d4PWM) {
                        if (val) {
                            this.d3PWM.set(7);
                        } else {
                            this.d3PWM.set(0);
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
            const rgbNow = RGBA.parse(oldVal);
            const rgbTo = RGBA.parse(val);
            if (!rgbNow || !rgbTo) {
                // ?
            } else if (rgbTo.compare(rgbNow) !== 0) {
                this.send({ type: 'ledstripe', value: new Array(64).fill(rgbTo.asString()).join(''), period: 800 });
            }
        }});
    public potentiometerProperty = newWritableProperty('Potentiometer', 0, new SpanHTMLRenderer(x => x.toString(10)));
    public readonly d3PWM?: WritableProperty<number>;
    public readonly d4PWM?: WritableProperty<number>;
    public readonly d7PWM?: WritableProperty<number>;

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
        if (this.devParams['hasPWMOnD0'] === 'true') {
            this._properties.push(this.screenEnabledProperty);
            this.d3PWM = this.createPWMProp("D3");
            this.d4PWM = this.createPWMProp("D4");
            this.d7PWM = this.createPWMProp("D7");
    
            this._properties.push(this.d3PWM);
            this._properties.push(this.d4PWM);
            this._properties.push(this.d7PWM);
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
                    this.relays.push(relay);
                    this._properties.push(relay);
                });
        }

        this._properties.push(Button.create("Restart", () => this.reboot()));
        const ipA = this.ip.match(/(\d*\.\d*\.\d*\.\d*)/);
        if (ipA) {
            this._properties.push(Button.createClientRedirect("Open settings", "http://" + ipA[0]));
        }

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

    public hasPWM() {
        return this.devParams["hasPWMOnD0"] === 'true';
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

    public playMp3(index: number): void {
        this.send({ type: 'playmp3', index: "" + index });
    }

    private lastVolChange?: number;

    public setVol(vol: number): void {
        const now = (new Date()).getTime();
        const send = () => {
            const value = "" + Math.round(Math.max(0, Math.min(30, (vol*30/100))));
            this.send({ type: 'setvolume', value });
        };
        if (this.lastVolChange == undefined || ((now - this.lastVolChange) > 300)) {
            send();
        } else {
            delay(300 - now - this.lastVolChange).then(send);
        }
        
    }

    private createPWMProp(pin: string): WritableProperty<number> {
        return newWritableProperty<number>(pin, 0, new SliderHTMLRenderer(), {
            onSet: (val: number) => {
                this.send({ type: 'pwm', value: val, pin, period: 500 });
            }})
    }

    public async play(vol: number, mp3index: number): Promise<void> {
        await this.setVol(vol);
        await delay(100);
        await this.playMp3(mp3index); // Литавры
    }

    public async boom(): Promise<void> {
        return this.play(50, 603);
    }

    public static readonly mp3Names: string[] = [
        'Труба трубит “отбой”',
        'Труба трубит “сбор”',
        'Труба трубит “ равнение на знамя”',
        'Сигнал горна - тревога',
        'Сигнал горна – фанфара',
        'Труба трубит “ заряжай”',
        'Труба трубит “ подъем”',
        'Сигнал горна - приветствие гвардии',
        'Сигнал горна - становись',
        'Сигнал горна - побудка',
        'Сигнал горна - поверка',
        'Сигнал горна - пожарная тревога',
        'Сигнал горна - привал',
        'Сигнал горна - отбой  2',
        'Сигнал горна - отбой 2',
        'Сигнал горна - отбой',
        'Сигнал горна - отступление',
        'Сигнал горна - королевское приветствие',
        'Сигнал горна - окончание парада',
        'Сигнал горна  - на обед',
        'Сигнал горна - викинги',
        'Сигнал горна - заряжай',
        'Почтовый горн 2',
        'Почтовый горн',
        'Литавры -нота ля',
        'Литавры -нота соль',
        'Литавры',
        'Удар по литаврам',
        'Звук литавры  ( вверх -вниз)',
        'Литавры 2',
        'Сверчки ночью - 1',
        'Сверчок',
        'Сверчки ночью – 2',
        'Рой саранчи',
        'Пчёлы',
        'На пруду - сверчки, лягушки',
        'Пчелиный улей',
        'Пчела',
        'Лягушки, птицы и другие звуки на болоте',
        'Лягушки',
        'Лягушка-вол',
        'Лягушка -вол  и насекомые',
        'Лягушка- вол',
        'Комар  2',
        'Комар',
        'Звук сверчков, шум транспорта на заднем плане',
        'Кваканье лягушек',
        'Жужжание пчел вокруг улья',
        'Звук сверчка',
        'Жужжание мухи',
        'Человек осел',
        'Человек- обезьяна',
        'Человек- курица',
        'Человек- мартышка',
        'Фантастические звуки',
        'Человек- корова',
        'Человек- горилла',
        'Тревога ” Чужой !”',
        'Скрежет ногтей по школьной доске',
        'Смех злой колдуньи',
        'Сумашедший',
        'Прерывистое сердцебиение',
        'Скрежет   зловещего  фортепиано',
        'Скрежещущий звук гонга',
        'Рычание монстра',
        'Пресс-эффект на зловещем фортепиано',
        'Причудливые завывания привидения',
        'Писк летучих мышей -вампиров',
        'Последний вздох',
        'Пение гиббона',
        'Писк гигантских летучих мышей',
        'Мужской стон',
        'Неполадки в космическом аппарате',
        'Механическое сердцебиение',
        'Мужской крик',
        'Мужской стон от боли',
        'Кричащие женщины',
        'Мужской крик ужаса',
        'Мужской крик ” Нет,нет, нет !”',
        'Космический звук  2',
        'Космический звук 1',
        'Космическое эхо',
        'Космические звуки',
        'Космический гонг',
        'Космическая тревога',
        'Космические куранты',
        'Имитация фисгармонии на зловещем фортепиано',
        'Звуки привидения',
        'Зловещее фортепиано - различные звуки',
        'Имитация звука арфы на    зловещем  фортепиано',
        'Дыхание при агонии 2',
        'Женский крик ужаса',
        'Женский крик',
        'Женский пронзительный визг',
        'Задыхающаяся женщина',
        'Задыхающийся мужчина',
        'Дыхание при агонии 1',
        'Драматический электронный эффект2',
        'Дыхание монстра',
        'Виброфон',
        'Глиссандо   на зловещем фортепиано',
        'Драматический электронный эффект1',
        'Ужасный смех',
        'Смех малыша',
        'Смех небольшой группы людей',
        'Смех старушки',
        'Спорящие мужчины',
        'Плач малыша',
        'Плач',
        'Пронзительный мужской крик',
        'Крик женщины',
        'Мужской смех',
        'Зловещий мужской смех (c эхом )',
        'Зловещий мужской смех',
        'Изображение человеком волчьего воя',
        'Истерический мужской смех',
        'Женский смех 2',
        'Женский смех',
        'Женское рыдание 2',
        'Женское рыдание',
        'Детский смех',
        'Женский визг',
        'Женский смех  2',
        'Щебет птиц на рассвете в деревне',
        'Визг смеющейся женщины',
        'Вздох облегчения небольшой группы людей',
        'Цыплята',
        'Чайки',
        'Хищная птица',
        'Цыплята в курятнике',
        'Стая уток , плеск крыльев по воде',
        'Тропические птицы',
        'Порханье птиц',
        'Сова',
        'Пение птиц на рассвете',
        'Писк цыплят , куры и петухи на заднем плане',
        'Пенье нескольких птиц',
        'Павлин',
        'Пение птиц',
        'Кряканье и плескание уток',
        'Павлин  2',
        'Кряканье и плескание уток и гусей',
        'Кудахтанье кур',
        'Крик лебедя на фоне шума воды',
        'Крик совы',
        'Крик ястреба',
        'Журавли, цапли и коршуны',
        'Карканье вороны , звуки других птиц вдалеке',
        'Крик петуха',
        'Канарейки',
        'Индейки',
        'Двухнедельный утенок',
        'Дикие петухи',
        'Гуси',
        'Гуси и утки',
        'Голуби в зоомагазине',
        'Голуби',
        'В курятнике',
        'Воробьи',
        'Раскат грома',
        'Продолжительные раскаты грома',
        'Проливной дождь',
        'Раскат грома   3',
        'Раскат грома  2',
        'После бури',
        'После грозы',
        'Дождь с грозой',
        'Зарница',
        'Дождь',
        'Дождь с грозой     2',
        'Грозовой ветер и дождь',
        'Дождь на пруду',
        'Грозовая буря с дождем',
        'Гроза и проливной дождь',
        'Буря, косой дождь',
        'Гроза',
        'Шум ветра',
        'Сильный ветер',
        'Шум ветра на фоне океана',
        'Легкое завывание ветра',
        'Мощные порывы ветра',
        'Завывание ветра 2',
        'Завывание ветра',
        'Ветер в деревьях',
        'Ветренный день в гавани',
        'Ветер 6',
        'Ветер 5',
        'Ветер 4',
        'Ветер 3',
        'Ветер 2',
        'Буря ночью',
        'Ветер 1',
        'Часы на церкви бьют 12 часов',
        'Часы с кукушкий бьют 1 час',
        'Часы с кукушкий бьют 12 часов',
        'Тиканье каминных часов',
        'Тиканье нескольких  каминных часов',
        'Часы на церкви бьют 1 час',
        'Городские часы бьют вдалеке 12 часов',
        'Старинные часы бьют 12 часов',
        'Городские часы бьют вдалеке 1 час',
        'Бубенцы приближаются',
        'Будильник',
        'Позвякивание колокольчиков',
        'Бубенчик',
        'Чайки -на побережье',
        'Бубенцы отдаляются',
        'Чайки -возле дока',
        'Чайки   на фоне прибоя',
        'Чайки - звук разбивающихся волн',
        'Серфинг - общая атмосфера',
        'Порог быстрой реки',
        'Подземный водопад',
        'Плеск воды о берег',
        'Под водой',
        'Небольшой водоворот',
        'Океанское побережье',
        'Море- лодки на воде',
        'Морская пещера',
        'Маленький водопад',
        'Звук разбивающихся волн',
        'Журчащий ручей',
        'Горный источник',
        'Всплеск рыбы в воде',
        'Глубоко под водой',
        'Вода, капающая в пещере',
        'Бурлящий ручей',
        'Быстрые горные пороги',
        'Бурлящий поток',
        'Большой водопад',
        'Бегущий поток',
        'Шаги в лесу',
        'Шаги по корридору',
        'Чудовище ,подволакивающее ногу',
        'Бег справа налево',
        'Звук шагов по листьям',
        'Бег по опавшей листве',
        'Бег слева направо',
        'Удар большого гонга',
        'Удар гонга',
        'Кастаньеты',
        'Удар в гонг',
        'Барабаны в пещере',
        'Быстрый ритм  барабанов',
        'Звук бубна',
        'Звук турецкого барабана',
        'Барабанная дробь2',
        'Барабанная дробь3',
        'Бубен',
        'Барабанная дробь',
        'Барабанная дробь1',
        'Барабанная дробь и  духовой инструмент -1',
        'Барабанная дробь и  духовой инструмент -2',
        'Барабанная дробь, звук тарелок',
        'Барабан',
        'Щенки в зоомагазине',
        'Щенок',
        'Хрюканье свиней в хлеву',
        'Шимпанзе в зоомагазине',
        'Шипение лесного кота',
        'Фырканье верблюда',
        'Трубящий слон , птицы на заднем плане',
        'Ферма - общая атмосфера',
        'Трещетка гремучей змеи',
        'Трубит разъяренный слон',
        'Тигрица',
        'Травля английскими гончими',
        'Табун лошадей, скучущих галопом',
        'Стадо овец',
        'Стадо слонов',
        'Собачий лай',
        'Скулящий щенок',
        'Собака рычит и лает',
        'Собачий лай 2',
        'Слон трубит',
        'Собака гонится за  человеком и лает',
        'Скулящая собака',
        'Скулящие собаки',
        'Скулящий щенок  2',
        'Свиньи  хрюкают в хлеву',
        'Свинья хрюкает и убегает',
        'Свиньи',
        'Рычание собаки',
        'Рычанье льва',
        'Рычание медведей',
        'Рычание собаки  2',
        'Рычание медведя',
        'Рычание крокодила',
        'Рычание лесного кота',
        'Рычание льва  вблизи',
        'Рычание и лай собаки',
        'Ржанье лошади 2',
        'Рычание горного льва',
        'Ржание и фырканье лошадей',
        'Ржание лошади  2',
        'Ржание лошади',
        'Ржанье лошади',
        'Пара лошадей, скачущих рысью  по асфальту',
        'Погон скота',
        'Разъяренные слоны',
        'Рев осла',
        'Пение петуха',
        'Мяукающий котенок',
        'Овцы козлы козлята',
        'Мяуканье котёнка',
        'Мяукающие котята',
        'Мурлыкающая и мяукающая кошка',
        'Мяуканье кошки',
        'Мыши',
        'Мурлыкающий котенок',
        'Мычание коровы',
        'Мычанье коровы',
        'Морские свинки',
        'Мурлыканье кошки',
        'Медведь',
        'Морские львы',
        'Мауканье кошек',
        'Львиный рык 2',
        'Львы',
        'Львиный рык',
        'Лошадь ходит по конюшне и фыркает',
        'Лошадь- ходит по конюшне и громко фыркает',
        'Львиный рык 3',
        'Лошадь ест овес',
        'Лошадь скачет легким галопом',
        'Лошадиный галоп',
        'Лошадь бежит рысью и фыркает',
        'Лошадиный галоп 2',
        'Лошадиный галоп 3',
        'Лошадиное ржанье в стойле',
        'Лошадиное фырканье',
        'Лай пуделя на улицы',
        'Лев',
        'Лай собаки',
        'Лай луговой собачки , деревенская атмосферва',
        'Кудахтанье курицы',
        'Лай котиков и морских львов',
        'Кряканье утки',
        'Крик лося',
        'Крик осла , общая атмосфера на ферме',
        'Крик осла',
        'Крик верблюда , водопад и птицы на заднем плане',
        'Кормление свиней',
        'Кошки',
        'Кошки и котята',
        'Кошка',
        'Котенок',
        'Кошачье мяуканье - 3 вида',
        'Коровник',
        'Козел',
        'Касатки',
        'Кашалот',
        'Злобное рычание собаки',
        'Домашние животные',
        'Животные в загоне',
        'Зловещий кошачий крик',
        'Дикие собаки',
        'Дыхание  лошади , ходящей по конюшне',
        'Дикие собаки и волки',
        'Горилла',
        'Волчий вой , другие волки вдалеке',
        'Горбатый кит в неволе',
        'Галоп лошади',
        'Вой и лай стаи волков',
        'Вой койота',
        'Вой волчей стаи вдалеке',
        'В зоопарке  шимпанзе, зебры, слоны, носорог , медведь',
        'Вой волков',
        'Визг свиньи',
        'Бурундук , деревенская атмосфера',
        'Белки',
        'Блеянье овец и ягнят  в загоне',
        'Африканские слоны',
        'Блеянье козла',
        'Одобрительные апплодисменты маленькой группы людей',
        'Одобрительные апплодисменты перед концертом',
        'Смех, апплодисменты в небольшой группе',
        'Вежливые апплодисменты небольшой группы',
        'Громкие апплодисменты группы людей',
        'Игра в гольф-аплодисменты',
        'Апплодисменты и крики на рок- концерте',
        'Апплодисменты маленькой аудитории',
        'Апплодисменты',
        'Апплодисменты и крики одобрения на концерте',
        'Апплодисменты в большой аудитории',
        'Аплодисменты при поздравлении',
        'Щебетание птиц- ночь в сельской местности',
        'Щебетание стайки птиц, сверчки ,нехрущи июньские , общая атмосфера в лесу',
        'Щебетание птиц в городе',
        'Щебетание и пение птиц в лесу',
        'Щебетание и пение птиц в тишине',
        'Тропический южноамериканский лес , звук водопада',
        'Пение козодоя - сверчки на заднем плане',
        'Петушиное пение , общая деревенская атмосфера',
        'Ночь в сельской местности',
        'Пение и щебетание птиц на фоне звука водопада в лесу',
        'Ночью в лесу',
        'На ферме - петухи, коровы ,птицы на заднем плане',
        'Летом в деревне',
        'Животное пробирается сквозь джунгли , крики животных',
        'Глубоко в джунглях',
        'Дятел стучит по дереву- другие птицы вдалеке',
        'В джунглях - крики птиц, шум воды',
        'Азиатский тропический дождевой лес',
        'Элетробритва',
        'Циркулярная пила',
        'Электропила',
        'Электроточилка  для карандашей',
        'Работающий пылесос',
        'Фотоаппарат-авт . смена кадра',
        'Торговый автомат - продажа прохладительных напитков',
        'Фотоаппарат - вспышка заряжается и срабатывает',
        'Ручной воздушный насос',
        'Работающая игрушечная машинка',
        'Работающий гидравлический лифт',
        'Работа посудомоечной машины',
        'Работа фена',
        'Работа циркулярной пилы',
        'Работа установки по переработке отходов',
        'Пропил дерева циркулярной пилой',
        'Работа игрушечной машинки',
        'Работа вентилятора',
        'Подъем на лифте ( ощущения пассажира)',
        'Прачечная',
        'Пар',
        'Перископ подводной лодки в работе',
        'Моторное отделение корабля',
        'Мытье машины- с позиции находящегося в салоне',
        'Открывающиеся двери лифта',
        'Магазин механических игрушек',
        'Морозильная камера для мяса',
        'Монстр оживает',
        'Кофе фильтруется',
        'Кофемолка',
        'Космическая лаборатория 1',
        'Космическая лаборатория 2',
        'Кондиционер включают и выключают',
        'Конвейер на фабрике',
        'Звук элекрической открывалки банок',
        'Игровой автомат и выдача денег',
        'Заправка бензином на бензоколонке',
        'Звук старого кинопроектора',
        'Загрузка мусоровозной машины',
        'Закрывающиеся двери лифта',
        'Затачивание  карандаша',
        'Деревообрабатывающая мастерская',
        'Загрузка тостера',
        'Жестокая стрижка',
        'Заворачивают гайку',
        'Газосварка',
        'Дверь -ширма открывается',
        'В лаборатории',
        'Готовый хлеб выскакивает из тостера',
        'Дверь -ширма закрывается',
        'Выигрыш в автомате - выплата денег',
        'Самолёты',
        'Автоматические двери в гараж открываются',
        'Бормашина',
        'Автоматические двери в гараж закрываются',
        'Автозаправочная станция -воздушный шланг',
        'Шум реактивного двигателя',
        'Радиообмен',
        'Самолёт',
        'Реактивный самолет пролетает и приземляется',
        'Пролетающий реактивный самолет',
        'Реактивный самолет ,пролетающий справа  налево',
        'Пролетающий военный реактивный самолет',
        'Пролетающий одновинтовой самолет',
        'Пролетающий пассажирский самолет',
        'Пролетающий  двухвинтовой самолет',
        'Пролетающий вертолет 2',
        'Пролетающий вертолет',
        'Пролетающий  винтовой самолет  2',
        'Пролетающий  военный реактивный самолет',
        'Пролетающий вертолет  2',
        'Пролетающий  винтовой самолет',
        'Прибытие вертолета и посадка',
        'Приземление самолета - визг шасси',
        'Приземление  реактивного самолета',
        'Приземление  вертолета',
        'Приземление   винтового  самолета',
        'Полет вертолета',
        'Посадка реактивного самолета',
        'Посадка самолета и визг шасси',
        'Полет в вертолете',
        'Инструктаж перед посадкой (англ.яз)',
        'Инструктаж перед полетом (англ.яз)',
        'Винтовой самолет запускает двигатели',
        'Взлет самолета',
        'Взлетающий двухвинтовой самолет',
        'Вертолет',
        'Взлет самолета 2',
        'Взлет реактивного самолета 3',
        'Взлет реактивного самолета',
        'Взлет реактивного самолета 2',
        'Взлет винтового самолета',
        'Взлет пассажирского самолета',
        'Взлет вертолета',
        'Взлет винтового самолета 2',
        'Вертолет запускается и взлетает',
        'Вертолет снижается и садится',
        'Вертолет приземляется',
        'В реактивном самолете,объявления экипажа',
        'Вертолет запускается и взлетает ( восприятие из вертолета )',
        'В винтовом самолете',
        'В полете  2.Пролетающий Конкорд  3. Авиакатастрофа1,2',
        'Авиакатастрофа и пожар',
        'Футбол- атмосфера на стадионе',
        'Фейерверк',
        'Фехтование- общая атмосфера во время матча',
        'Удары с лета в теннисе',
        'Упражнения с тяжестями',
        'Толпа на скачках',
        'Сквош - общая атмосфера во время игры',
        'Рыбалка(море) - заброс,вытаскивают рыбу',
        'Рыбалка(река)  - заброс,наматывание лески',
        'Раздача карт',
        'Ребенок плывет',
        'Прыгалка',
        'Пул - шары разбивают',
        'Пул- комбинированный удар',
        'Плавание в бассейне',
        'Прогулка в лодке ,гребля',
        'На американских горках',
        'Перетасовка карт 2',
        'Перетасовка карт',
        'Карнавал',
        'Картинг - общая атмосфера',
        'Ныряют и уплывают',
        'Игравой автомат',
        'Карате - крики, удары',
        'Игра в боулинг - общая атмосфера',
        'Игра в боулинг – общая атмосфера',
        'Залы видеоигр - общая атмосфера',
        'Игра в Patchinco',
        'Зал видеоигр - общая атмосфера',
        'Дети играют(англ.яз.)',
        'Grand Prix -атмосфера на стадионе , комментарии',
        'Боксирование с “грушей”',
        'Боулиг - удар',
        'Боулинг - мяч катится',
        'Бег- справа налево',
        'Бейсбол - удар алюминиевой битой по мячу',
        'Электронный сигнал радара',
        'Электронный звук гидролокатора',
        'Ящики картотечного шкафа открывают и закрывают',
        'Электронный будильник',
        'Часы с кукушкой бьют 12 часов',
        'Чашку ставят на блюдце',
        'Шипение-огонь',
        'Школьный звонок звонит несколько раз',
        'Щелчок выключателя',
        'Щелчок зажигалки',
        'Щелчок пальцами',
        'Тиканье секундомера',
        'Удар деревянной биты по мячу',
        'Удар молотка в суде',
        'Хлыст',
        'Хруст картофельных чипсов',
        'Хруст сломанной ветки',
        'Треск',
        'Трубку вешают -версия1',
        'Удар алюминиевой  биты по мячу',
        'Тиканье будильника',
        'Тиканье нескольких часов  2',
        'Счет монет',
        'Телефон звонит 3 раза и трубку поднимают',
        'Телефон- поднимают трубку',
        'Телефон-набирают номер -занято',
        'Стекло',
        'Стрельба из лука -стрела попадает в мишень',
        'Стук в дверь - дверь открывается, стучавший входит',
        'Стул, царапающий пол',
        'Скачущий мяч',
        'Смена кадров',
        'Содовую наливают в стакан',
        'Скрепление степлером',
        'Скрип костей',
        'Скрип кроссовок по полу',
        'Сирена',
        'Скачущий мяч удаляется',
        'Сирена  2',
        'Скачущий мяч  удаляется',
        'Роняют поднос с тарелками',
        'Свист тростника в воздухе',
        'Свисток судьи',
        'Сигнал SOS, передаваемой по азбуке Морзе',
        'Сигнал в телевизионной игре 2',
        'Сигнал в телевизионной игре',
        'Сильное шипение',
        'Работа принтера',
        'Ракета',
        'Расстегивание молнии',
        'Роняют  поднос с тарелками',
        'Пробка, вылетающая из бутылки с шампанским',
        'Пробка, вылетающая из бутылки',
        'Пробку вытаскивают ( с эхом)',
        'Пьют через соломинку, глоток',
        'Разбивают оконное стекло',
        'Напиток ведьм',
        'Открывают банку содовой',
        'Пробка вылетает из бутылки шампанского',
        'Пробка выскакивает из бутылки шампанского',
        'Пробка, вылетающая из бутылки 2',
        'Неправильный ответ',
        'Ногти по школьной доске',
        'Кубики льда в стакане-2',
        'Лопается воздушный шарик - эхо',
        'Молния застегивается',
        'Молния расстегивается',
        'Монеты кидают на стол',
        'Надувают воздушный шарик',
        'Кнопочный телефон',
        'Колокол пожарной тревоги',
        'Колотушка',
        'Кубики льда в ведерке',
        'Кубики льда в стакане-1',
        'Капли – 2',
        'Колдовское зелье',
        'Звук  гидролокатора восприятие из подводной лодки',
        'Клавиатура компьютера',
        'Капли  - 1',
        'Звук хлыста',
        'Зуммер домофона',
        'Капающая вода',
        'Звук капающей воды с эхом',
        'Звонок при входе на бензоколонку - 2',
        'Звук бьющегося стакана',
        'Звук затвора 35 мм фотоаппарата',
        'Звон стаканов в тосте 2',
        'Звон стаканов в тосте',
        'Звонок велосипеда',
        'Звонок из таксофона',
        'Звонок кассового аппарата',
        'Звонок при входе на бензоколонку – 1',
        'Звон монет ,брошенных на стол',
        'Звон монет',
        'Звон стакана в тосте',
        'Звон стаканов в тосте  2',
        'Городские часы бьют 12 часов',
        'Дребезжащие на подносе стаканы',
        'Застегивание молнии',
        'Затачивание карандаша',
        'Звон большого хрустального стакана',
        'Звон маленького хрустального стакана',
        'Грязь с бетона собирают в совок',
        'Гудок легковой автомашины -один',
        'Гремящие цепи',
        'Вспышка заряжается и срабатывает',
        'Газированная вода',
        'Гидролокатор подводной лодки',
        'Воздушные пузырьки в воде',
        'Воздушный шарик лопается',
        'Воздушный шарик надувают',
        'Воздушный шарик отпускают',
        'Всплеск воды',
        'Большие пузыри в воде',
        'В пещере капает вода',
        'Велосипедный звонок',
        'Воздушный шарик лопается с эхом',
        'Банку содовой открывают ,воду наливают',
        'Банку закрывают крышкой  2',
        'Банку закрывают крышкой',
        'Бег  по бетонной дороге',
        'Большая дверь закрывается , эхо',
        'Cообщение на азбуке Морзе',
        'Автоматический привод фотоаппарата',
        'Аэрозоль - непродолжительное распыление',
        'Ядерный взрыв',
        'Танки',
        'Узи пулемет -короткие и средние очереди',
        'Стрельба из станкового пулемета',
        'Стрельба из танка',
        'Три  выстрела из крупнокалиберного пистолета',
        'Стрельба из пулемета AK 47',
        'Стрельба из пулемета M 60 - длинные очереди',
        'Стрельба из пулемета времен I мировой войны',
        'Стрельба из револьвера на улице с эхом',
        'Стрельба из пистолета на улице -15 выстрелов',
        'Стрельба из крупнокалиберного пистолета на улице',
        'Стрельба из немецкой винтовки времен II мировой войны',
        'Стрельба из нескольких винтовок М1',
        'Стрельба из винтовки 30-30 на улице с эхом - 3 выстрела',
        'Стрельба из винтовки - выстрел, перезарядка, снова выстрел',
        'Стрельба из винтовки- 3 приказа стрелять - салют 3 раза',
        'Стрельба из 50-ти калиберного пулеметы- короткие очереди',
        'Стрельба из автоматической винтовки  на улице',
        'Стрельба из 40- мм двустволки',
        'Стрельба из 45-калиберного пистолета',
        'Стрельба из 37-мм противотанкового орудия , 5 выстрелов',
        'Стрельба из 40 -мм  корабельного зенитного орудия',
        'Стрельба и огонь из пулемета М 60',
        'Стрельба из 16 дюйм. корабельного орудия   , выстрелов',
        'Стрельба из 22- калиберного оружия  - 6 выстрелов',
        'Стрельба из 38-калиберного полуавтоматического  пистолета',
        'Сражение -XVIII -XIX век',
        'Стрельба  из армейской винтовки М 16',
        'Сражение -ХХ  век',
        'Снаряд 75 калибра разрывается',
        'Рикошеты и огонь из автомата',
        'Ряд взрывов',
        'Свист падающего метательного снаряда - взрыв',
        'Слабый взрыв с падающими осколками',
        'Пушечная  стрельба- 10 длинных выстрелов',
        'Рикошет от скалы',
        'Пулеметная стрельба',
        'Пулеметный обстрел',
        'Пушка',
        'Поле боя -стрельба из пистолетов',
        'Пролетающий артиллерийский снаряд - взрыв',
        'Пулеметная очередь - ответный огонь',
        'Пулеметная очередь- ответный огонь',
        'Пулеметная очередь',
        'Приказ стрелять из пушки',
        'Перестрелка',
        'Приближение и взрыв снаряда из 105- мм гаубицы - 2 раза',
        'Огнестрельная битва - эхо нескольких винтовок в каньоне',
        'Перестрелка, одного убивают',
        'Пистолет - один выстрел',
        'Пистолетные выстрелы',
        'Один выстрел из крупнокалиберного пистолета',
        'Перестрелка ( с транспортом)',
        'Перестрелка из машины',
        'Воздушный  налёт',
        'Несколько пушечных выстрелов , некоторые вдалеке',
        'Мощный взрыв динамита',
        'Небольшой снаряд',
        'Несколько авт . винтовок браунинг стреляют вместе',
        'Звук пули авт . винтовки браунинг',
        'Множество взрывов',
        'Забивание шомпола в cтаринную пушку ( 3 раза)',
        'Зарядка револьвера 25 калибра',
        'Выстрел из миномета 81 калибра',
        'Выстрел',
        'Длинный рикошет',
        'Винтовка М 14 - несколько выстрелов',
        'Выстрел из винчестера , перезарядка между выстрелами - 5 раз',
        'Взрыв глубинной бомбы - шум воды',
        'Взрыв с падающими осколками',
        'Взрыв средней мощности',
        'Взрыв',
        'Винтовка - один выстрел',
        'Винтовка М 14 - один выстрел',
        'Взрыв и падающие осколки 2',
        'Взрыв и падающие осколки',
        'Взрыв ручной гранаты - падают комки  земли',
        '6 выстрелов из винтовки М-1',
        'Автоматные рикошеты 1',
        'Автоматные рикошеты 2',
        'Взвод винтовки',
        'Судно на воздушной подушке',
        '3 выстрела из 45 калибра',
        '3 выстрела из винтовки',
        'Моторная лодка заводится- двигатель набирает обороты - отключается',
        'Подводная лодка- звук гидролокатора',
        'Проходящий паром',
        'Моторная лодка ,набирающая скорость',
        'Моторная лодка ,движущаяся с постоянной скоростью',
        'Корабль в море',
        'Катер- заводится и отчаливает',
        'Баржа, движущаяся на медленной скорости',
        'Катер  -проплывает на большой скорости',
        '2 корабельных гудка',
        'Скопище рожков',
        'Труба насмехается',
        'Труба- ржание',
        'Флексатон - нисходящий ряд',
        'Флексатон -восходящий ряд',
        'Привидения- электронная версия',
        'Свист ветра',
        'Свист',
        'Придурок',
        'Прикольный рожок',
        'Свист 2',
        'Оркестровое пение птиц',
        'Праздничные рожки',
        'Праздничный рожок',
        'Оркестр настраивается  2',
        'Оркестр настраивается',
        'Настройка дудочки- женщина собирается петь',
        'Нисходящее глиссандо на арфе 2',
        'Нисходящее глиссандо на арфе',
        'Нисходящий свист',
        'Волынки',
        'Восходящее глиссандо на арфе',
        'Гитара- перебор открытых струн',
        'Имитация лошадиного ржания на трубе',
        'Ксилофон \'Loneranger\'',
        'Волынка - шотландская мелодия',
        'Восклицание',
        'Восходящее глиссандо на арфе 2',
        'Военный оркестр на параде',
        'Арфа - нисходящее глиссандо',
        'Арфа -восходящее глиссандо',
        'Безумное пианино',
        'Быстрый восходящий свист',
        'Быстрый нисходящий свист',
        '1.Плохая игра на скрипке  20 - 2. Сигнал “отбой” 09 - 3.Орган из “мыльной оперы” 1,2',
        '5 сим. Бетховена- начало',
        'Арфа - “Добро  пожаловать на небеса “',
        'Столярная мастерская',
        'Рыбалка на тихом озере',
        'Электрические искры',
        'Потрескивание огня',
        'Рубка мачете',
        'Полицейская рация',
        'Рубка дерева топором',
        'Пожарная тревога',
        'Запуск ракеты с отсчетом',
        'Нож Боло -нарезка',
        'Падающее дерево в лесу',
        'Кресло- качалка матушки Бейтс',
        'Закрепление прически лаком',
        'Казнь на электрическом стуле',
        'Дерево рубят и оно падает',
        'Драка двух мужчин -удары, звуки борьбы',
        'Вскапывание земли в саду',
        'Высокое напряжение',
        '1.Бушующий огонь и вой ветра 112  - 2. Землетрясение  3. Вулкан  4. Лава',
        'Возле доков - общая атмосфера',
        'Бушующий огонь',
        '1. Занавеска  04  -  2. Кандалы на ногах 2  -  3. Волочение кандалов с гирей 08',
        '3 телефонных звонка - трубку поднимают',
        'Набор номера на дисковом телефоне',
        'Трубку вешают- версия 2',
        'Швыряют телефонную трубку',
        '1 звонок - трубку поднимают',
        'Смех  группы мужчин',
        'Толпа, охваченная паникой',
        'Публика на вечеринке',
        'Радостное одобрительное восклицание небольшой группы',
        'Реация на пропущенную лунку у зрителей гольфа',
        'Пьяные',
        'Крики  толпы',
        'Одобрительные детские возгласы',
        'Группа восклицает',
        'Группа детей',
        'Легкий  смех в аудитории',
        'Возглас удовлетворения толпы',
        'Возглас удовлетворенной толпы',
        'Возгласы небольшой толпы',
        'Воодушевленные мужчины после веселого разговора',
        'Агрессивная  толпа',
        'Возглас отвращения в толпе',
        'Возглас отвращения толпы',
        'Возглас разочарования толпы',
        'Возглас разочарованной толпы',
        'Возглас удивления ,поражения',
        'Агрессивная компания',
        'Вздох удивления небольшой группы',
        '\'Right on\' и ответные реплики прихожан',
        'Храп монстра',
        '“Сюрприз” на вечеринке',
        'Тарзан - крик джунглей',
        'Трещотка',
        'Стрельба из лазерного  оружия  2',
        'Стрельба из лазерного  оружия',
        'Судья объявляет “ вы выходите из игры”',
        'Тирольский призыв',
        'Смех гуманоида',
        'Собачий смех',
        'Смех тропической птицы',
        'Скрипучая кровать',
        'Смех бурундука',
        'Свист ракеты - выстрел из лазерного оружия  2',
        'Сигнал машины в виде мычания коровы',
        'Мужчина, храпящий во время веселого сна',
        'Пробка  пищит и вылетает',
        'Продавец кричит -“ хотдоги “',
        'Свист ракеты - выстрел из лазерного оружия  1',
        'Мычание монстра',
        'Кондуктор дает сигнал к отправлению',
        'Короткая  отрыжка',
        'Космический смертельный луч',
        'Молния',
        'Мужская отрыжка',
        'Дурацкое печатание',
        'Комический рикошет- 9 выстрелов',
        'В шланге кончилась вода',
        'Гудок',
        'Детская отрыжка',
        'Звук отрыжки',
        'В кране кончилась вода',
        'Ворчание злого гнома',
        'kazoo',
        'Бомба с часовым механизмом',
        '“Крута-а-ая”',
        '“Кто это сделал',
        'Поездка в метро',
        'Поезд в метро прибывает на станцию и уезжает',
        'Поезд проезжает переезд',
        'Паровоз трогается',
        'На железнодорожной станции',
        'В поезде',
        'Паравоз выпускает пар',
        'Шум между вагонами движущегося поезда',
        'Станция метро',
        'Фуникулёр',
        'Проходящий поезд',
        'Свист паравоза',
        'Проходящий мимо паровоз',
        'Проезжающий трамвай - восприятие из салона',
        'Проезжающий трамвай',
        'Проезжающий поезд',
        'Проезжающий поезд в метро',
        'Поездка на фуникулёре',
        'Пригородный поезд прибывает и остановливается , а затем отходит',
        'Бар с фортепьяно',
        'Аэропорт- зал прибытия',
        'Аэропорт- проверка билетов',
        'Автомобильная пробка , сигналят',
        'Строительная площадка',
        'Телетайпы в информационном отделе',
        'Публика на параде',
        'Рынок- общая атмосфера',
        'Пешеходы в деловой части города',
        'Пробка , продолжительные сигналы',
        'Пешеходная аллея',
        'Парк игр и развлечений',
        'Офис- общая атмосфера',
        'На открытом воздухе',
        'На карнавале',
        'Магазин теле-, радиоаппаратуры',
        'Контроль на выходе из супермаркета',
        'Дождь с грозой в городе',
        'Городское движение',
        'В кафе',
        'Городское движение 2',
        'В аэропорту',
        'В информационном отделе',
        'Стук в дверь - дверь открывается',
        'Стук в дверь 2',
        'Стрижка волос',
        'Струя воды',
        'Спуск по лестнице',
        'Слив в туалете 2',
        'Слив в туалете',
        'Спичку зажигают',
        'Руки вытирают полотенцем',
        'Сильное шипение на сковороде',
        'Скрип деревянных ворот',
        'Раковину наполняют водой',
        'Раскалывание яиц',
        'Рвут материал',
        'Радио- настойка на FM',
        'Размешивание в чашке',
        'Просматривание газеты',
        'Пьют из питьевого  фонтанчика',
        'Радио - настройка на АМ',
        'Поливка из шланга',
        'Помехи',
        'Потягивание кофе',
        'Пол моют щеткой',
        'Поджаривание бекона',
        'Подъем по лестнице',
        'Подметание пола',
        'Поднос с дребезжащими стаканами',
        'Пишут на школьной доске 2',
        'Пишут на школьной доске',
        'Питьевой фонтанчик включают и выключают',
        'Печатание письма',
        'Письмо открывают',
        'Письмо сминают и выбрасывают 2',
        'Письмо сминают и выбрасывают',
        'Пиление ручной пилой',
        'Перетасовка и раздача карт',
        'Натирание моркови на терке',
        'Открывется скрипучая дверь',
        'Нарезка овощей',
        'Книга- перелистывание страниц',
        'Намазывание масла на тост',
        'Конверт открывают',
        'Легкое шипение на сковороде',
        'Мытье рук в раковине',
        'Звон посуды',
        'Игла проигрывателя царапает пластинку',
        'Затачивание ножа 3',
        'Звонки в дверь',
        'Затачивание ножа 1',
        'Железные ворота открывают',
        'Закрывется скрипучая дверь',
        'Засорившийся туалет',
        'Затачивание ножа  2',
        'В душе-1',
        'Дверной звонок звонит несколько раз',
        'Дверь закрывается',
        'Дверь открывается',
        'Железные ворота закрывают',
        'Гвозди забивают в дерево',
        'Дверная ручка',
        'Газету рвут',
        'В стакан наливают воду',
        'Воду выпускают из раковины',
        'Бумагу сминают',
        'Бумажный пакет надевают на голову и снимают',
        'Быстро рвут материал',
        'Бег по бетонной дороге',
        'Бумагу рвут ( быстро)',
        'Бумагу рвут ( медленно)',
        'Яйца взбивают в миске',
        'Щетка падает',
        'Ящик закрывается со скрипом',
        'Ящик открывается со скрипом',
        'Чистка зубов 2',
        'Чистка зубов',
        'Шаги по деревянному покрытию',
        'Царапанье в дверь',
        'Стук в дверь',
        'Тревога по радио',
        'Хлопают дверью',
        'Испуганное дыхание',
        'Биение сердца',
        'Женщина икает',
        'Биение сердца 2',
        'Фырканье и чавканье',
        'Чихание',
        'Тяжелое дыхание',
        'Урчание в желудке',
        'Отрыжка',
        'Рассройство желудка',
        'Тяжёлое дыхание',
        'Мужчина очень шумно сморкается',
        'Мужчина сморкается',
        'Мужчина чихает',
        'Мужской храп',
        'Мужчина зевает',
        'Лизание',
        'Мужской кашель 2',
        'Мужской кашель',
        'Короткая отрыжка',
        'Автокатастрофа, крик',
        'Автомобиль  заводится , двигатель набирает обороты',
        'Автомобиль - открывают капот',
        'Автобус приезжает и останавливается, затем трогается',
        'Автокатастрофа, “цепная реакция”',
        'Авария',
        'Холостой ход спортивного автомобиля',
        '“Скорая” проезжает с сиреной',
        'Шорох колес проезжающего автомобиля',
        'Холостой ход автомобиля',
        'Холостой ход гоночного автомобиля',
        'Холостой ход  старинного автомобиля',
        'Формула 1',
        'Транспорт , двигающийся на средней скорости',
        'У скоростного автомобиля заканчивается горючее',
        'Формула 1 - автомобиль проносится мимо',
        'Транспорт , двигающийся на большой  скорости',
        'таринный автомобиль уезжает и возвращается',
        'Скоростной автомобиль трогается и останавливается',
        'Спортивный автомобиль заводится и уезжает',
        'Спортивный автомобиль приближается и останавливается',
        'Скоростной автомобиль заводится и работает на холостом ходу',
        'Скоростной автомобиль на холостом ходу',
        'Скоростной автомобиль заводится , горючее заканчивается',
        'Скоростной автомобиль заводится , горючее заканчивается  2',
        'Скоростная машина трогается и останавливается',
        'Скоростной автомобиль - горючее заканчивается- версия 2',
        'Скоростной автомобиль - скорость 150 mph',
        'Сигнализация автомобиля',
        'Сигнал грузовика',
        'Сильный  занос - серьезная авария',
        'Проезжающий грузовик',
        'Сигнал автомобиля 2',
        'Сигнал автомобиля 3',
        'Сигнал грузовика - 1 гудок',
        'Сигнал грузовика - 2 гудка',
        'Проезжающий спортивный автомобиль',
        'Сигнал автомобиля 1',
        'Проезжающие автомобили',
        'Проезжающий армейский джип',
        'Проезжающий грузовик сигналит 2',
        'Проезжающий грузовик сигналит',
        'Проезжающий автомобиль',
        'Проезжает полицейская машина с сиреной',
        'Проезжающая машина сигналит',
        'Проезжающий автомобиль сигналит',
        'Полицейская машина трогается с сиреной',
        'Полиция с сиреной приближается и останавливается',
        'Мытьё машины, ощущение изнутри',
        'Полицейская машина  уезжает с сиреной',
        'Мотоцикл, проезжающий на скорости 100 миль в час',
        'Несколько автомобильных гудков',
        'Мотоцикл стоит ,трогается',
        'Мотоцикл, проезжающий на скорости 55 миль в час 2',
        'Мотоцикл, проезжающий на скорости 55 миль в час',
        'Мотоцикл уезжает',
        'Мотоцикл приближается и останавливается',
        'Мотоцикл проезжает мимо',
        'Мотоцикл заводится и отъезжает',
        'Мотоцикл набирает скорость',
        'Легковой автомобиль не заводится',
        'Лобовое столкновение',
        'Легковой автомобиль- быстрая парковка в гараже',
        'Звук мотоцикла',
        'Звук тормозов грузовика',
        'Легковой автомобиль - двери закрываются на стоянке',
        'Звук велосипедной цепи',
        'Звук “дворников”',
        'Занос на льду',
        'Двигающийся автобус - восприятие из салона',
        'Занос и авария',
        'Занос - визг шин',
        'Занос автомобиля- визг шин',
        'Двигатель спортивного автомобиля набирает обороты',
        'Длинные автомобильные гудки',
        'Гонки на дороге - восприятие из салона',
        'Двигатель заводится',
        'Двигатель набирает обороты',
        'Двигатель не заводится',
        'Дверца автомобиля закрывается',
        'Дверца автомобиля открывается',
        'Гоночный автомобиль уезжает',
        'В грузовике',
        'Большой грузовик приближается,останавливается , а затем уезжает',
        'Визг колес  восприятие из салона',
        'Визг колес',
        'Большой грузовик уезжает',
        'Автомобильные гонки',
        'Армейский грузовик на холостом ходу',
        'Автомобильный гудок',
        'Автомобиль проносится со скоростью 160 mph',
        'Автомобиль с севшим аккумулятором',
        'Автомобильная авария , крик',
        'Автомобильный гудок- 1 сигнал',
        'Автомобиль приближается и его заносит',
        'Автомобиль приближается и останавливается , двигатель выключается',
        'Автомобиль заносит - авария',
        'Автомобиль заносит - небольшая авария',
        'Автомобиль приближается , легкий визг шин',
        'Автомобиль -закрывают капот',
        'Автомобиль заводится и уезжает 2',
        'Автомобиль заводится и уезжает 3',
        'Автомобиль заводится и уезжает',
        'Автомобиль , едущий со спущенным колесом',
        'Автомобиль ,двигающийся со средней скоростью',
        'Автомобиль быстро приближается и тормозит',
    ] 
}
