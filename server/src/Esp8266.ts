import { Relay, Controller, Property, ClassWithId, PropertyImpl, SpanHTMLRenderer, Button, newWritableProperty, SliderHTMLRenderer, StringAndGoRendrer, CheckboxHTMLRenderer, SelectHTMLRenderer } from "./Props";
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

interface PotentiometerState extends Msg {
    type: 'potentiometer';
    value: number;
    timeseq: number;
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
    "brightness": string,          // Brightness [0..100] "0"
    "relay.names": string,         // Relay names, separated by ;
    "hasLedStripe": string,        // Has LED stripe
    "hasPotenciometer"?: string,   // Has potentiometer
    "hasPWMOnD0"?: string,
    "hasDFPlayer"?: string
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

type AnyMessage = Log | Temp | Hello | IRKey | Weight | ButtonPressed | PingResult | RelayState | LedStripeState | PotentiometerState;

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
    public potentiometerProperty = newWritableProperty('Potentiometer', 0, new SpanHTMLRenderer(x => x.toString(10)));
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
        if (this.devParams['hasDFPlayer'] === 'true') {
            // Nothing ATM
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
            this._properties.push(this.potentiometerProperty);
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

    public hasPWMOnD0() {
        return this.devParams["hasPWMOnD0"] === 'true';
    }

    public setPWMOnD0(val: number) {
        this.send({ type: 'pwm', value: val});
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

    public static readonly mp3Names: string[] = [
        "Смех, апплодисменты в небольшой группе",
        "Шум ветра",
        "Биение сердца",
        "Одобрительные апплодисменты перед концертом",
        "Шум ветра на фоне океана",
        "kazoo",
        "Одобрительные апплодисменты маленькой группы людей",
        "Биение сердца 2",
        "Ветер 6",
        "Игра в гольф-аплодисменты",
        "Сильный ветер",
        "Громкие апплодисменты группы людей",
        "Женщина икает",
        "Лизание",
        "Вежливые апплодисменты небольшой группы",
        "Мощные порывы ветра",
        "Ветер 5",
        "Апплодисменты",
        "Испуганное дыхание",
        "Апплодисменты маленькой аудитории",
        "Легкое завывание ветра",
        "Апплодисменты и крики одобрения на концерте",
        "Короткая отрыжка",
        "Отрыжка",
        "Апплодисменты и крики на рок- концерте",
        "Завывание ветра",
        "Чихание",
        "Апплодисменты в большой аудитории",
        "Мужской кашель",
        "Аплодисменты при поздравлении",
        "Завывание ветра 2",
        "Мужской кашель 2",
        "Ветренный день в гавани",
        "Мужской храп",
        "Ветер в деревьях",
        "Мужчина зевает",
        "Ветер 4",
        "Авария",
        "Ветер 3",
        "Формула 1",
        "Ветер 2",
        "В душе-1",
        "Ветер 1",
        "Помехи",
        "Буря ночью",
        "Мужчина сморкается",
        "Ящики картотечного шкафа открывают и закрывают",
        "Мужчина очень шумно сморкается",
        "Электронный сигнал радара",
        "Мужчина чихает",
        "Электронный звук гидролокатора",
        "Рассройство желудка",
        "Электронный будильник",
        "Тяжёлое дыхание",
        "Щелчок пальцами",
        "Тяжелое дыхание",
        "Щелчок зажигалки",
        "Урчание в желудке",
        "Щелчок выключателя",
        "Фырканье и чавканье",
        "Школьный звонок звонит несколько раз",
        "Автокатастрофа, крик",
        "В кафе",
        "Шипение-огонь",
        "Автомобильные гонки",
        "Чашку ставят на блюдце",
        "Автокатастрофа, \"цепная реакция",
        "Часы с кукушкой бьют 12 часов",
        "Автомобиль - открывают капот",
        "Хруст сломанной ветки",
        "Автомобиль -закрывают капот",
        "Хруст картофельных чипсов",
        "Автомобиль заводится и уезжает",
        "Хлыст",
        "В поезде",
        "Удар молотка в суде",
        "Автомобильный гудок",
        "Удар деревянной биты по мячу",
        "Автомобиль заводится и уезжает 2",
        "Удар алюминиевой  биты по мячу",
        "Автомобиль заводится и уезжает 3",
        "Трубку вешают -версия1",
        "Автомобиль заносит - авария",
        "Треск",
        "Фуникулёр",
        "Тиканье секундомера",
        "В грузовике",
        "Тиканье нескольких часов  2",
        "Автомобиль с севшим аккумулятором",
        "Тиканье будильника",
        "Визг колес",
        "Телефон-набирают номер -занято",
        "Автомобильная авария , крик",
        "Телефон- поднимают трубку",
        "Автомобильный гудок- 1 сигнал",
        "Телефон звонит 3 раза и трубку поднимают",
        "Автомобиль , едущий со спущенным колесом",
        "Счет монет",
        "Двигатель заводится",
        "Стул, царапающий пол",
        "Двигатель не заводится",
        "Стук в дверь - дверь открывается, стучавший входит",
        "Автобус приезжает и останавливается, затем трогается",
        "Стрельба из лука -стрела попадает в мишень",
        "Автомобиль ,двигающийся со средней скоростью",
        "Стекло",
        "Гроза",
        "Содовую наливают в стакан",
        "Армейский грузовик на холостом ходу",
        "Смена кадров",
        "Занос - визг шин",
        "Скрип кроссовок по полу",
        "Большой грузовик уезжает",
        "Скрип костей",
        "Занос и авария",
        "Скрепление степлером",
        "Занос на льду",
        "Скачущий мяч",
        "Звук велосипедной цепи",
        "Скачущий мяч удаляется",
        "Визг колес  восприятие из салона",
        "Скачущий мяч  удаляется",
        "Гоночный автомобиль уезжает",
        "Сирена",
        "Дождь",
        "Сирена  2",
        "Звук мотоцикла",
        "Сильное шипение",
        "Звук \"дворников",
        "Сигнал в телевизионной игре",
        "Дверца автомобиля закрывается",
        "Сигнал в телевизионной игре 2",
        "Дверца автомобиля открывается",
        "Сигнал SOS, передаваемой по азбуке Морзе",
        "Автомобиль быстро приближается и тормозит",
        "Свисток судьи",
        "Лобовое столкновение",
        "Свист тростника в воздухе",
        "Двигатель набирает обороты",
        "Роняют поднос с тарелками",
        "Длинные автомобильные гудки",
        "Роняют  поднос с тарелками",
        "Занос автомобиля- визг шин",
        "Расстегивание молнии",
        "Мотоцикл уезжает",
        "Ракета",
        "Зарница",
        "Разбивают оконное стекло",
        "Звук тормозов грузовика",
        "Работа принтера",
        "Проезжающие автомобили",
        "Пьют через соломинку, глоток",
        "Легковой автомобиль не заводится",
        "Пробку вытаскивают ( с эхом)",
        "Мотоцикл заводится и отъезжает",
        "Пробка, вылетающая из бутылки",
        "Мотоцикл набирает скорость",
        "Пробка, вылетающая из бутылки с шампанским",
        "Автомобиль заносит - небольшая авария",
        "Пробка, вылетающая из бутылки 2",
        "Мотоцикл проезжает мимо",
        "Пробка выскакивает из бутылки шампанского",
        "Автомобиль приближается , легкий визг шин",
        "Пробка вылетает из бутылки шампанского",
        "Автомобиль приближается и его заносит",
        "Открывают банку содовой",
        "Мотоцикл стоит ,трогается",
        "Ногти по школьной доске",
        "Мытьё машины, ощущение изнутри",
        "Неправильный ответ",
        "Проезжающий автомобиль",
        "Напиток ведьм",
        "Проезжающий грузовик",
        "Надувают воздушный шарик",
        "Несколько автомобильных гудков",
        "Монеты кидают на стол",
        "Проезжающая машина сигналит",
        "Молния расстегивается",
        "Проезжающий автомобиль сигналит",
        "Молния застегивается",
        "Сигнал автомобиля 1",
        "Лопается воздушный шарик - эхо",
        "Проезжающий армейский джип",
        "Кубики льда в стакане-2",
        "Проезжающий грузовик сигналит",
        "Кубики льда в стакане-1",
        "Проезжающий грузовик сигналит 2",
        "Кубики льда в ведерке",
        "Проезжающий спортивный автомобиль",
        "Колотушка",
        "Сигнал автомобиля 2",
        "Колокол пожарной тревоги",
        "Сигнал автомобиля 3",
        "Колдовское зелье",
        "Сигнал грузовика",
        "Кнопочный телефон",
        "Бег по бетонной дороге",
        "Клавиатура компьютера",
        "Сигнал грузовика - 1 гудок",
        "Капли – 2",
        "Бумагу рвут ( быстро)",
        "Капли  - 1",
        "Бумагу сминают",
        "Капающая вода",
        "Быстро рвут материал",
        "Зуммер домофона",
        "В стакан наливают воду",
        "Звук хлыста",
        "Газету рвут",
        "Звук капающей воды с эхом",
        "Сигнал грузовика - 2 гудка",
        "Звук затвора 35 мм фотоаппарата",
        "Сигнализация автомобиля",
        "Звук бьющегося стакана",
        "Сильный  занос - серьезная авария",
        "Звук  гидролокатора восприятие из подводной лодки",
        "Автомобиль  заводится , двигатель набирает обороты",
        "Звонок при входе на бензоколонку – 1",
        "Автомобиль проносится со скоростью 160 mph",
        "Звонок при входе на бензоколонку - 2",
        "Гонки на дороге - восприятие из салона",
        "Звонок кассового аппарата",
        "Холостой ход  старинного автомобиля",
        "Звонок из таксофона",
        "Дверная ручка",
        "Звонок велосипеда",
        "Дверь закрывается",
        "Звон стаканов в тосте",
        "Холостой ход автомобиля",
        "Звон стаканов в тосте 2",
        "Холостой ход гоночного автомобиля",
        "Звон стаканов в тосте  2",
        "Холостой ход спортивного автомобиля",
        "Звон стакана в тосте",
        "Дверь открывается",
        "Звон монет",
        "Засорившийся туалет",
        "Звон монет ,брошенных на стол",
        "Шорох колес проезжающего автомобиля",
        "Звон маленького хрустального стакана",
        "Двигающийся автобус - восприятие из салона",
        "Звон большого хрустального стакана",
        "Легковой автомобиль- быстрая парковка в гараже",
        "Затачивание карандаша",
        "\"Скорая проезжает с сиреной",
        "Застегивание молнии",
        "Затачивание ножа  2",
        "Дребезжащие на подносе стаканы",
        "Бумагу рвут ( медленно)",
        "Гудок легковой автомашины -один",
        "Воду выпускают из раковины",
        "Грязь с бетона собирают в совок",
        "Гвозди забивают в дерево",
        "Гремящие цепи",
        "Затачивание ножа 1",
        "Городские часы бьют 12 часов",
        "Дверной звонок звонит несколько раз",
        "Гидролокатор подводной лодки",
        "Железные ворота закрывают",
        "Газированная вода",
        "Затачивание ножа 3",
        "Вспышка заряжается и срабатывает",
        "Железные ворота открывают",
        "Всплеск воды",
        "Звон посуды",
        "Воздушный шарик отпускают",
        "Закрывется скрипучая дверь",
        "Воздушный шарик надувают",
        "Звонки в дверь",
        "Воздушный шарик лопается",
        "Книга- перелистывание страниц",
        "Воздушный шарик лопается с эхом",
        "Конверт открывают",
        "Воздушные пузырьки в воде",
        "Легкое шипение на сковороде",
        "Велосипедный звонок",
        "Мытье рук в раковине",
        "В пещере капает вода",
        "Нарезка овощей",
        "Большие пузыри в воде",
        "Намазывание масла на тост",
        "Большая дверь закрывается , эхо",
        "Натирание моркови на терке",
        "Бег  по бетонной дороге",
        "Открывется скрипучая дверь",
        "Банку содовой открывают ,воду наливают",
        "Мотоцикл приближается и останавливается",
        "Банку закрывают крышкой",
        "Перетасовка и раздача карт",
        "Банку закрывают крышкой  2",
        "Печатание письма",
        "Аэрозоль - непродолжительное распыление",
        "Мотоцикл, проезжающий на скорости 100 миль в час",
        "Автоматический привод фотоаппарата",
        "Мотоцикл, проезжающий на скорости 55 миль в час",
        "Cообщение на азбуке Морзе",
        "Автомобиль приближается и останавливается , двигатель выключается",
        "Большой грузовик приближается,останавливается , а затем уезжает",
        "Двигатель спортивного автомобиля набирает обороты",
        "Легковой автомобиль - двери закрываются на стоянке",
        "Мотоцикл, проезжающий на скорости 55 миль в час 2",
        "Полицейская машина  уезжает с сиреной",
        "Полицейская машина трогается с сиреной",
        "Полиция с сиреной приближается и останавливается",
        "Проезжает полицейская машина с сиреной",
        "Скоростная машина трогается и останавливается",
        "Скоростной автомобиль - горючее заканчивается- версия 2",
        "Скоростной автомобиль - скорость 150 mph",
        "Скоростной автомобиль заводится , горючее заканчивается",
        "Скоростной автомобиль заводится , горючее заканчивается  2",
        "Скоростной автомобиль заводится и работает на холостом ходу",
        "Скоростной автомобиль на холостом ходу",
        "Скоростной автомобиль трогается и останавливается",
        "Спортивный автомобиль заводится и уезжает",
        "Спортивный автомобиль приближается и останавливается",
        "Транспорт , двигающийся на большой  скорости",
        "Транспорт , двигающийся на средней скорости",
        "У скоростного автомобиля заканчивается горючее",
        "Формула 1 - автомобиль проносится мимо",
        "таринный автомобиль уезжает и возвращается",
        "Бумажный пакет надевают на голову и снимают",
        "Игла проигрывателя царапает пластинку",
        "Пиление ручной пилой",
        "Письмо открывают",
        "Письмо сминают и выбрасывают",
        "Письмо сминают и выбрасывают 2",
        "Питьевой фонтанчик включают и выключают",
        "Пишут на школьной доске",
        "Пишут на школьной доске 2",
        "Поджаривание бекона",
        "Подметание пола",
        "Поднос с дребезжащими стаканами",
        "Подъем по лестнице",
        "Пол моют щеткой",
        "Поливка из шланга",
        "Потягивание кофе",
        "Просматривание газеты",
        "Пьют из питьевого  фонтанчика",
        "Радио - настройка на АМ",
        "Радио- настойка на FM",
        "Размешивание в чашке",
        "Раковину наполняют водой",
        "Раскалывание яиц",
        "Рвут материал",
        "Руки вытирают полотенцем",
        "Сильное шипение на сковороде",
        "Скрип деревянных ворот",
        "Слив в туалете",
        "Слив в туалете 2",
        "Спичку зажигают",
        "Спуск по лестнице",
        "Стрижка волос",
        "Струя воды",
        "Стук в дверь",
        "Стук в дверь - дверь открывается",
        "Стук в дверь 2",
        "Тревога по радио",
        "Хлопают дверью",
        "Царапанье в дверь",
        "Чистка зубов",
        "Чистка зубов 2",
        "Шаги по деревянному покрытию",
        "Щетка падает",
        "Яйца взбивают в миске",
        "Ящик закрывается со скрипом",
        "Ящик открывается со скрипом",
        "Автомобильная пробка , сигналят",
        "Аэропорт- зал прибытия",
        "Аэропорт- проверка билетов",
        "Бар с фортепьяно",
        "В аэропорту",
        "В информационном отделе",
        "Городское движение",
        "Городское движение 2",
        "Дождь с грозой в городе",
        "Контроль на выходе из супермаркета",
        "Магазин теле-, радиоаппаратуры",
        "На карнавале",
        "На открытом воздухе",
        "Офис- общая атмосфера",
        "Парк игр и развлечений",
        "Пешеходная аллея",
        "Пешеходы в деловой части города",
        "Пробка , продолжительные сигналы",
        "Публика на параде",
        "Рынок- общая атмосфера",
        "Строительная площадка",
        "Телетайпы в информационном отделе",
        "На железнодорожной станции",
        "Паравоз выпускает пар",
        "Паровоз трогается",
        "Поезд в метро прибывает на станцию и уезжает",
        "Поезд проезжает переезд",
        "Поездка в метро",
        "Поездка на фуникулёре",
        "Пригородный поезд прибывает и остановливается , а затем отходит",
        "Проезжающий поезд",
        "Проезжающий поезд в метро",
        "Проезжающий трамвай",
        "Проезжающий трамвай - восприятие из салона",
        "Проходящий мимо паровоз",
        "Проходящий поезд",
        "Свист паравоза",
        "Станция метро",
        "Шум между вагонами движущегося поезда",
        "Буря, косой дождь",
        "Гроза и проливной дождь",
        "Грозовая буря с дождем",
        "Грозовой ветер и дождь",
        "Дождь на пруду",
        "Дождь с грозой",
        "Дождь с грозой     2",
        "После бури",
        "После грозы",
        "Продолжительные раскаты грома",
        "Проливной дождь",
        "Раскат грома",
        "Раскат грома   3",
        "Раскат грома  2",
        "Африканские слоны",
        "Белки",
        "Блеянье козла",
        "Блеянье овец и ягнят  в загоне",
        "Бурундук , деревенская атмосфера",
        "В зоопарке  шимпанзе, зебры, слоны, носорог , медведь",
        "Визг свиньи",
        "Вой волков",
        "Вой волчей стаи вдалеке",
        "Вой и лай стаи волков",
        "Вой койота",
        "Волчий вой , другие волки вдалеке",
        "Галоп лошади",
        "Горбатый кит в неволе",
        "Горилла",
        "Дикие собаки",
        "Дикие собаки и волки",
        "Домашние животные",
        "Дыхание  лошади , ходящей по конюшне",
        "Животные в загоне",
        "Злобное рычание собаки",
        "Зловещий кошачий крик",
        "Касатки",
        "Кашалот",
        "Козел",
        "Кормление свиней",
        "Коровник",
        "Котенок",
        "Кошачье мяуканье - 3 вида",
        "Кошка",
        "Кошки",
        "Кошки и котята",
        "Крик верблюда , водопад и птицы на заднем плане",
        "Крик лося",
        "Крик осла",
        "Крик осла , общая атмосфера на ферме",
        "Кряканье утки",
        "Кудахтанье курицы",
        "Лай котиков и морских львов",
        "Лай луговой собачки , деревенская атмосферва",
        "Лай пуделя на улицы",
        "Лай собаки",
        "Лев",
        "Лошадиное ржанье в стойле",
        "Лошадиное фырканье",
        "Лошадиный галоп",
        "Лошадиный галоп 2",
        "Лошадиный галоп 3",
        "Лошадь бежит рысью и фыркает",
        "Лошадь ест овес",
        "Лошадь скачет легким галопом",
        "Лошадь ходит по конюшне и фыркает",
        "Лошадь- ходит по конюшне и громко фыркает",
        "Львиный рык",
        "Львиный рык 2",
        "Львиный рык 3",
        "Львы",
        "Мауканье кошек",
        "Медведь",
        "Морские львы",
        "Морские свинки",
        "Мурлыканье кошки",
        "Мурлыкающая и мяукающая кошка",
        "Мурлыкающий котенок",
        "Мычание коровы",
        "Мычанье коровы",
        "Мыши",
        "Мяуканье котёнка",
        "Мяуканье кошки",
        "Мяукающие котята",
        "Мяукающий котенок",
        "Овцы козлы козлята",
        "Пара лошадей, скачущих рысью  по асфальту",
        "Пение петуха",
        "Погон скота",
        "Разъяренные слоны",
        "Рев осла",
        "Ржание и фырканье лошадей",
        "Ржание лошади",
        "Ржание лошади  2",
        "Ржанье лошади",
        "Ржанье лошади 2",
        "Рычание горного льва",
        "Рычание и лай собаки",
        "Рычание крокодила",
        "Рычание лесного кота",
        "Рычание льва  вблизи",
        "Рычание медведей",
        "Рычание медведя",
        "Рычание собаки",
        "Рычание собаки  2",
        "Рычанье льва",
        "Свиньи",
        "Свиньи  хрюкают в хлеву",
        "Свинья хрюкает и убегает",
        "Скулящая собака",
        "Скулящие собаки",
        "Скулящий щенок",
        "Скулящий щенок  2",
        "Слон трубит",
        "Собака гонится за  человеком и лает",
        "Собака рычит и лает",
        "Собачий лай",
        "Собачий лай 2",
        "Стадо овец",
        "Стадо слонов",
        "Табун лошадей, скучущих галопом",
        "Тигрица",
        "Травля английскими гончими",
        "Трещетка гремучей змеи",
        "Трубит разъяренный слон",
        "Трубящий слон , птицы на заднем плане",
        "Ферма - общая атмосфера",
        "Фырканье верблюда",
        "Хрюканье свиней в хлеву",
        "Шимпанзе в зоомагазине",
        "Шипение лесного кота",
        "Щенки в зоомагазине",
        "Щенок",
        "Азиатский тропический дождевой лес",
        "В джунглях - крики птиц, шум воды",
        "Глубоко в джунглях",
        "Дятел стучит по дереву- другие птицы вдалеке",
        "Животное пробирается сквозь джунгли , крики животных",
        "Летом в деревне",
        "На ферме - петухи, коровы ,птицы на заднем плане",
        "Ночь в сельской местности",
        "Ночью в лесу",
        "Пение и щебетание птиц на фоне звука водопада в лесу",
        "Пение козодоя - сверчки на заднем плане",
        "Петушиное пение , общая деревенская атмосфера",
        "Тропический южноамериканский лес , звук водопада",
        "Щебетание и пение птиц в лесу",
        "Щебетание и пение птиц в тишине",
        "Щебетание птиц в городе",
        "Щебетание птиц- ночь в сельской местности",
        "Щебетание стайки птиц, сверчки ,нехрущи июньские , общая атмосфера в лесу",
        "Бегущий поток",
        "Большой водопад",
        "Бурлящий поток",
        "Бурлящий ручей",
        "Быстрые горные пороги",
        "Вода, капающая в пещере",
        "Всплеск рыбы в воде",
        "Глубоко под водой",
        "Горный источник",
        "Журчащий ручей",
        "Звук разбивающихся волн",
        "Маленький водопад",
        "Море- лодки на воде",
        "Морская пещера",
        "Небольшой водоворот",
        "Океанское побережье",
        "Плеск воды о берег",
        "Под водой",
        "Подземный водопад",
        "Порог быстрой реки",
        "Серфинг - общая атмосфера",
        "Чайки   на фоне прибоя",
        "Чайки - звук разбивающихся волн",
        "Чайки -возле дока",
        "Чайки -на побережье",
        "Жужжание мухи",
        "Жужжание пчел вокруг улья",
        "Звук сверчка",
        "Звук сверчков, шум транспорта на заднем плане",
        "Кваканье лягушек",
        "Комар",
        "Комар  2",
        "Лягушка -вол  и насекомые",
        "Лягушка- вол",
        "Лягушка-вол",
        "Лягушки",
        "Лягушки, птицы и другие звуки на болоте",
        "На пруду - сверчки, лягушки",
        "Пчёлы",
        "Пчела",
        "Пчелиный улей",
        "Рой саранчи",
        "Сверчки ночью - 1",
        "Сверчки ночью – 2",
        "Сверчок",
        "В курятнике",
        "Воробьи",
        "Голуби",
        "Голуби в зоомагазине",
        "Гуси",
        "Гуси и утки",
        "Двухнедельный утенок",
        "Дикие петухи",
        "Журавли, цапли и коршуны",
        "Индейки",
        "Канарейки",
        "Карканье вороны , звуки других птиц вдалеке",
        "Крик лебедя на фоне шума воды",
        "Крик петуха",
        "Крик совы",
        "Крик ястреба",
        "Кряканье и плескание уток",
        "Кряканье и плескание уток и гусей",
        "Кудахтанье кур",
        "Павлин",
        "Павлин  2",
        "Пение птиц",
        "Пение птиц на рассвете",
        "Пенье нескольких птиц",
        "Писк цыплят , куры и петухи на заднем плане",
        "Порханье птиц",
        "Сова",
        "Стая уток , плеск крыльев по воде",
        "Тропические птицы",
        "Хищная птица",
        "Цыплята",
        "Цыплята в курятнике",
        "Чайки",
        "Щебет птиц на рассвете в деревне",
        "2 корабельных гудка",
        "Баржа, движущаяся на медленной скорости",
        "Катер  -проплывает на большой скорости",
        "Катер- заводится и отчаливает",
        "Корабль в море",
        "Моторная лодка ,движущаяся с постоянной скоростью",
        "Моторная лодка ,набирающая скорость",
        "Моторная лодка заводится- двигатель набирает обороты - отключается",
        "Подводная лодка- звук гидролокатора",
        "Проходящий паром",
        "Судно на воздушной подушке",
        "Вздох облегчения небольшой группы людей",
        "Визг смеющейся женщины",
        "Детский смех",
        "Женский визг",
        "Женский смех",
        "Женский смех  2",
        "Женский смех 2",
        "Женское рыдание",
        "Женское рыдание 2",
        "Зловещий мужской смех",
        "Зловещий мужской смех (c эхом )",
        "Изображение человеком волчьего воя",
        "Истерический мужской смех",
        "Крик женщины",
        "Мужской смех",
        "Плач",
        "Плач малыша",
        "Пронзительный мужской крик",
        "Смех малыша",
        "Смех небольшой группы людей",
        "Смех старушки",
        "Спорящие мужчины",
        "Ужасный смех",
        "Виброфон",
        "Глиссандо   на зловещем фортепиано",
        "Драматический электронный эффект1",
        "Драматический электронный эффект2",
        "Дыхание монстра",
        "Дыхание при агонии 1",
        "Дыхание при агонии 2",
        "Женский крик",
        "Женский крик ужаса",
        "Женский пронзительный визг",
        "Задыхающаяся женщина",
        "Задыхающийся мужчина",
        "Звуки привидения",
        "Зловещее фортепиано - различные звуки",
        "Имитация звука арфы на    зловещем  фортепиано",
        "Имитация фисгармонии на зловещем фортепиано",
        "Космическая тревога",
        "Космические звуки",
        "Космические куранты",
        "Космический гонг",
        "Космический звук  2",
        "Космический звук 1",
        "Космическое эхо",
        "Кричащие женщины",
        "Механическое сердцебиение",
        "Мужской крик",
        "Мужской крик ужаса",
        "Мужской крик  Нет,нет, нет !",
        "Мужской стон",
        "Мужской стон от боли",
        "Неполадки в космическом аппарате",
        "Пение гиббона",
        "Писк гигантских летучих мышей",
        "Писк летучих мышей -вампиров",
        "Последний вздох",
        "Прерывистое сердцебиение",
        "Пресс-эффект на зловещем фортепиано",
        "Причудливые завывания привидения",
        "Рычание монстра",
        "Скрежет   зловещего  фортепиано",
        "Скрежет ногтей по школьной доске",
        "Скрежещущий звук гонга",
        "Смех злой колдуньи",
        "Сумашедший",
        "Тревога  Чужой !",
        "Фантастические звуки",
        "Человек осел",
        "Человек- горилла",
        "Человек- корова",
        "Человек- курица",
        "Человек- мартышка",
        "Человек- обезьяна",
        "Барабан",
        "Барабанная дробь",
        "Барабанная дробь и  духовой инструмент -1",
        "Барабанная дробь и  духовой инструмент -2",
        "Барабанная дробь, звук тарелок",
        "Барабанная дробь1",
        "Барабанная дробь2",
        "Барабанная дробь3",
        "Барабаны в пещере",
        "Бубен",
        "Быстрый ритм  барабанов",
        "Звук бубна",
        "Звук турецкого барабана",
        "Кастаньеты",
        "Удар большого гонга",
        "Удар в гонг",
        "Удар гонга",
        "Почтовый горн",
        "Почтовый горн 2",
        "Сигнал горна  - на обед",
        "Сигнал горна - викинги",
        "Сигнал горна - заряжай",
        "Сигнал горна - королевское приветствие",
        "Сигнал горна - окончание парада",
        "Сигнал горна - отбой",
        "Сигнал горна - отбой  2",
        "Сигнал горна - отбой 2",
        "Сигнал горна - отступление",
        "Сигнал горна - побудка",
        "Сигнал горна - поверка",
        "Сигнал горна - пожарная тревога",
        "Сигнал горна - привал",
        "Сигнал горна - приветствие гвардии",
        "Сигнал горна - становись",
        "Сигнал горна - тревога",
        "Сигнал горна – фанфара",
        "Труба трубит \" заряжай",
        "Труба трубит \" подъем",
        "Труба трубит \" равнение на знамя",
        "Труба трубит \"отбой",
        "Труба трубит \"сбор",
        "Бубенцы отдаляются",
        "Бубенцы приближаются",
        "Бубенчик",
        "Позвякивание колокольчиков",
        "Звук литавры  ( вверх -вниз)",
        "Литавры",
        "Литавры -нота ля",
        "Литавры -нота соль",
        "Литавры 2",
        "Удар по литаврам",
        "1.Плохая игра на скрипке  20 - 2. Сигнал \"отбой 09 - 3.Орган из \"мыльной оперы 1,2",
        "5 сим. Бетховена- начало",
        "Арфа - нисходящее глиссандо",
        "Арфа - \"Добро  пожаловать на небеса \"",
        "Арфа -восходящее глиссандо",
        "Безумное пианино",
        "Быстрый восходящий свист",
        "Быстрый нисходящий свист",
        "Военный оркестр на параде",
        "Волынка - шотландская мелодия",
        "Волынки",
        "Восклицание",
        "Восходящее глиссандо на арфе",
        "Восходящее глиссандо на арфе 2",
        "Гитара- перебор открытых струн",
        "Имитация лошадиного ржания на трубе",
        "Ксилофон  Loneranger",
        "Настройка дудочки- женщина собирается петь",
        "Нисходящее глиссандо на арфе",
        "Нисходящее глиссандо на арфе 2",
        "Нисходящий свист",
        "Оркестр настраивается",
        "Оркестр настраивается  2",
        "Оркестровое пение птиц",
        "Праздничные рожки",
        "Праздничный рожок",
        "Привидения- электронная версия",
        "Придурок",
        "Прикольный рожок",
        "Свист",
        "Свист 2",
        "Свист ветра",
        "Скопище рожков",
        "Труба насмехается",
        "Труба- ржание",
        "Флексатон - нисходящий ряд",
        "Флексатон -восходящий ряд",
        "3 выстрела из 45 калибра",
        "3 выстрела из винтовки",
        "6 выстрелов из винтовки М-1",
        "Автоматные рикошеты 1",
        "Автоматные рикошеты 2",
        "Взвод винтовки",
        "Взрыв",
        "Взрыв глубинной бомбы - шум воды",
        "Взрыв и падающие осколки",
        "Взрыв и падающие осколки 2",
        "Взрыв ручной гранаты - падают комки  земли",
        "Взрыв с падающими осколками",
        "Взрыв средней мощности",
        "Винтовка - один выстрел",
        "Винтовка М 14 - несколько выстрелов",
        "Винтовка М 14 - один выстрел",
        "Воздушный  налёт",
        "Выстрел",
        "Выстрел из винчестера , перезарядка между выстрелами - 5 раз",
        "Выстрел из миномета 81 калибра",
        "Длинный рикошет",
        "Забивание шомпола в cтаринную пушку ( 3 раза)",
        "Зарядка револьвера 25 калибра",
        "Звук пули авт . винтовки браунинг",
        "Множество взрывов",
        "Мощный взрыв динамита",
        "Небольшой снаряд",
        "Несколько авт . винтовок браунинг стреляют вместе",
        "Несколько пушечных выстрелов , некоторые вдалеке",
        "Огнестрельная битва - эхо нескольких винтовок в каньоне",
        "Один выстрел из крупнокалиберного пистолета",
        "Перестрелка",
        "Перестрелка ( с транспортом)",
        "Перестрелка из машины",
        "Перестрелка, одного убивают",
        "Пистолет - один выстрел",
        "Пистолетные выстрелы",
        "Поле боя -стрельба из пистолетов",
        "Приближение и взрыв снаряда из 105- мм гаубицы - 2 раза",
        "Приказ стрелять из пушки",
        "Пролетающий артиллерийский снаряд - взрыв",
        "Пулеметная очередь",
        "Пулеметная очередь - ответный огонь",
        "Пулеметная очередь- ответный огонь",
        "Пулеметная стрельба",
        "Пулеметный обстрел",
        "Пушечная  стрельба- 10 длинных выстрелов",
        "Пушка",
        "Рикошет от скалы",
        "Рикошеты и огонь из автомата",
        "Ряд взрывов",
        "Свист падающего метательного снаряда - взрыв",
        "Слабый взрыв с падающими осколками",
        "Снаряд 75 калибра разрывается",
        "Сражение -XVIII -XIX век",
        "Сражение -ХХ  век",
        "Стрельба  из армейской винтовки М 16",
        "Стрельба и огонь из пулемета М 60",
        "Стрельба из 16 дюйм. корабельного орудия   , выстрелов",
        "Стрельба из 22- калиберного оружия  - 6 выстрелов",
        "Стрельба из 37-мм противотанкового орудия , 5 выстрелов",
        "Стрельба из 38-калиберного полуавтоматического  пистолета",
        "Стрельба из 40 -мм  корабельного зенитного орудия",
        "Стрельба из 40- мм двустволки",
        "Стрельба из 45-калиберного пистолета",
        "Стрельба из 50-ти калиберного пулеметы- короткие очереди",
        "Стрельба из автоматической винтовки  на улице",
        "Стрельба из винтовки - выстрел, перезарядка, снова выстрел",
        "Стрельба из винтовки 30-30 на улице с эхом - 3 выстрела",
        "Стрельба из винтовки- 3 приказа стрелять - салют 3 раза",
        "Стрельба из крупнокалиберного пистолета на улице",
        "Стрельба из немецкой винтовки времен II мировой войны",
        "Стрельба из нескольких винтовок М1",
        "Стрельба из пистолета на улице -15 выстрелов",
        "Стрельба из пулемета AK 47",
        "Стрельба из пулемета M 60 - длинные очереди",
        "Стрельба из пулемета времен I мировой войны",
        "Стрельба из револьвера на улице с эхом",
        "Стрельба из станкового пулемета",
        "Стрельба из танка",
        "Танки",
        "Три  выстрела из крупнокалиберного пистолета",
        "Узи пулемет -короткие и средние очереди",
        "Ядерный взрыв",
        "1. Занавеска  04  -  2. Кандалы на ногах 2  -  3. Волочение кандалов с гирей 08",
        "1.Бушующий огонь и вой ветра 112  - 2. Землетрясение  3. Вулкан  4. Лава",
        "Бушующий огонь",
        "Возле доков - общая атмосфера",
        "Вскапывание земли в саду",
        "Высокое напряжение",
        "Дерево рубят и оно падает",
        "Драка двух мужчин -удары, звуки борьбы",
        "Закрепление прически лаком",
        "Запуск ракеты с отсчетом",
        "Казнь на электрическом стуле",
        "Кресло- качалка матушки Бейтс",
        "Нож Боло -нарезка",
        "Падающее дерево в лесу",
        "Пожарная тревога",
        "Полицейская рация",
        "Потрескивание огня",
        "Рубка дерева топором",
        "Рубка мачете",
        "Рыбалка на тихом озере",
        "Столярная мастерская",
        "Электрические искры",
        "Авиакатастрофа и пожар",
        "В винтовом самолете",
        "В полете  2.Пролетающий Конкорд  3. Авиакатастрофа1,2",
        "В реактивном самолете,объявления экипажа",
        "Вертолет",
        "Вертолет запускается и взлетает",
        "Вертолет запускается и взлетает ( восприятие из вертолета )",
        "Вертолет приземляется",
        "Вертолет снижается и садится",
        "Взлет вертолета",
        "Взлет винтового самолета",
        "Взлет винтового самолета 2",
        "Взлет пассажирского самолета",
        "Взлет реактивного самолета",
        "Взлет реактивного самолета 2",
        "Взлет реактивного самолета 3",
        "Взлет самолета",
        "Взлет самолета 2",
        "Взлетающий двухвинтовой самолет",
        "Винтовой самолет запускает двигатели",
        "Инструктаж перед полетом (англ.яз)",
        "Инструктаж перед посадкой (англ.яз)",
        "Полет в вертолете",
        "Полет вертолета",
        "Посадка реактивного самолета",
        "Посадка самолета и визг шасси",
        "Прибытие вертолета и посадка",
        "Приземление   винтового  самолета",
        "Приземление  вертолета",
        "Приземление  реактивного самолета",
        "Приземление самолета - визг шасси",
        "Пролетающий  винтовой самолет",
        "Пролетающий  винтовой самолет  2",
        "Пролетающий  военный реактивный самолет",
        "Пролетающий  двухвинтовой самолет",
        "Пролетающий вертолет",
        "Пролетающий вертолет  2",
        "Пролетающий вертолет 2",
        "Пролетающий военный реактивный самолет",
        "Пролетающий одновинтовой самолет",
        "Пролетающий пассажирский самолет",
        "Пролетающий реактивный самолет",
        "Радиообмен",
        "Реактивный самолет ,пролетающий справа  налево",
        "Реактивный самолет пролетает и приземляется",
        "Самолёт",
        "Самолёты",
        "Шум реактивного двигателя",
        "Grand Prix -атмосфера на стадионе , комментарии",
        "Бег- справа налево",
        "Бейсбол - удар алюминиевой битой по мячу",
        "Боксирование с \"грушей",
        "Боулиг - удар",
        "Боулинг - мяч катится",
        "Дети играют(англ.яз.)",
        "Зал видеоигр - общая атмосфера",
        "Залы видеоигр - общая атмосфера",
        "Игра в Patchinco",
        "Игра в боулинг - общая атмосфера",
        "Игра в боулинг – общая атмосфера",
        "Игравой автомат",
        "Карате - крики, удары",
        "Карнавал",
        "Картинг - общая атмосфера",
        "На американских горках",
        "Ныряют и уплывают",
        "Перетасовка карт",
        "Перетасовка карт 2",
        "Плавание в бассейне",
        "Прогулка в лодке ,гребля",
        "Прыгалка",
        "Пул - шары разбивают",
        "Пул- комбинированный удар",
        "Раздача карт",
        "Ребенок плывет",
        "Рыбалка(море) - заброс,вытаскивают рыбу",
        "Рыбалка(река)  - заброс,наматывание лески",
        "Сквош - общая атмосфера во время игры",
        "Толпа на скачках",
        "Удары с лета в теннисе",
        "Упражнения с тяжестями",
        "Фейерверк",
        "Фехтование- общая атмосфера во время матча",
        "Футбол- атмосфера на стадионе",
        "1 звонок - трубку поднимают",
        "3 телефонных звонка - трубку поднимают",
        "Набор номера на дисковом телефоне",
        "Трубку вешают- версия 2",
        "Швыряют телефонную трубку",
        "Автозаправочная станция -воздушный шланг",
        "Автоматические двери в гараж закрываются",
        "Автоматические двери в гараж открываются",
        "Бормашина",
        "В лаборатории",
        "Выигрыш в автомате - выплата денег",
        "Газосварка",
        "Готовый хлеб выскакивает из тостера",
        "Дверь -ширма закрывается",
        "Дверь -ширма открывается",
        "Деревообрабатывающая мастерская",
        "Жестокая стрижка",
        "Заворачивают гайку",
        "Загрузка мусоровозной машины",
        "Загрузка тостера",
        "Закрывающиеся двери лифта",
        "Заправка бензином на бензоколонке",
        "Затачивание  карандаша",
        "Звук старого кинопроектора",
        "Звук элекрической открывалки банок",
        "Игровой автомат и выдача денег",
        "Конвейер на фабрике",
        "Кондиционер включают и выключают",
        "Космическая лаборатория 1",
        "Космическая лаборатория 2",
        "Кофе фильтруется",
        "Кофемолка",
        "Магазин механических игрушек",
        "Монстр оживает",
        "Морозильная камера для мяса",
        "Моторное отделение корабля",
        "Мытье машины- с позиции находящегося в салоне",
        "Открывающиеся двери лифта",
        "Пар",
        "Перископ подводной лодки в работе",
        "Подъем на лифте ( ощущения пассажира)",
        "Прачечная",
        "Пропил дерева циркулярной пилой",
        "Работа вентилятора",
        "Работа игрушечной машинки",
        "Работа посудомоечной машины",
        "Работа установки по переработке отходов",
        "Работа фена",
        "Работа циркулярной пилы",
        "Работающая игрушечная машинка",
        "Работающий гидравлический лифт",
        "Работающий пылесос",
        "Ручной воздушный насос",
        "Торговый автомат - продажа прохладительных напитков",
        "Фотоаппарат - вспышка заряжается и срабатывает",
        "Фотоаппарат-авт . смена кадра",
        "Циркулярная пила",
        "Электропила",
        "Электроточилка  для карандашей",
        "Элетробритва",
        "Right on и ответные реплики прихожан",
        "Агрессивная  толпа",
        "Агрессивная компания",
        "Вздох удивления небольшой группы",
        "Возглас отвращения в толпе",
        "Возглас отвращения толпы",
        "Возглас разочарования толпы",
        "Возглас разочарованной толпы",
        "Возглас удивления ,поражения",
        "Возглас удовлетворения толпы",
        "Возглас удовлетворенной толпы",
        "Возгласы небольшой толпы",
        "Воодушевленные мужчины после веселого разговора",
        "Группа восклицает",
        "Группа детей",
        "Крики  толпы",
        "Легкий  смех в аудитории",
        "Одобрительные детские возгласы",
        "Публика на вечеринке",
        "Пьяные",
        "Радостное одобрительное восклицание небольшой группы",
        "Реация на пропущенную лунку у зрителей гольфа",
        "Смех  группы мужчин",
        "Толпа, охваченная паникой",
        "\"Сюрприз на вечеринке",
        "Будильник",
        "Городские часы бьют вдалеке 1 час",
        "Городские часы бьют вдалеке 12 часов",
        "Старинные часы бьют 12 часов",
        "Тиканье каминных часов",
        "Тиканье нескольких  каминных часов",
        "Часы на церкви бьют 1 час",
        "Часы на церкви бьют 12 часов",
        "Часы с кукушкий бьют 1 час",
        "Часы с кукушкий бьют 12 часов",
        "Бег по опавшей листве",
        "Бег слева направо",
        "Бег справа налево",
        "Звук шагов по листьям",
        "Чудовище ,подволакивающее ногу",
        "Шаги в лесу",
        "Шаги по корридору",
        "Бомба с часовым механизмом",
        "В кране кончилась вода",
        "В шланге кончилась вода",
        "Ворчание злого гнома",
        "Гудок",
        "Детская отрыжка",
        "Дурацкое печатание",
        "Звук отрыжки",
        "Комический рикошет- 9 выстрелов",
        "Кондуктор дает сигнал к отправлению",
        "Короткая  отрыжка",
        "Космический смертельный луч",
        "Молния",
        "Мужская отрыжка",
        "Мужчина, храпящий во время веселого сна",
        "Мычание монстра",
        "Пробка  пищит и вылетает",
        "Продавец кричит -\" хотдоги \"",
        "Свист ракеты - выстрел из лазерного оружия  1",
        "Свист ракеты - выстрел из лазерного оружия  2",
        "Сигнал машины в виде мычания коровы",
        "Скрипучая кровать",
        "Смех бурундука",
        "Смех гуманоида",
        "Смех тропической птицы",
        "Собачий смех",
        "Стрельба из лазерного  оружия",
        "Стрельба из лазерного  оружия  2",
        "Судья объявляет \" вы выходите из игры",
        "Тарзан - крик джунглей",
        "Тирольский призыв",
        "Трещотка",
        "Храп монстра",
        "\"Крута-а-ая",
        "\"Кто это сделал",
    ] 
}
