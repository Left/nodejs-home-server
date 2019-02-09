import { Relay, Controller, Property, ClassWithId, PropertyImpl, SpanHTMLRenderer, Button, newWritableProperty, SliderHTMLRenderer, StringAndGoRendrer, CheckboxHTMLRenderer } from "./Props";
import { LcdInformer } from './Informer';
import { delay } from './Util';
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
    type: 'temp';
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

export interface Hello extends Msg {
    type: 'hello';
    firmware: string;
    afterRestart: number;
    screenEnabled?: boolean; 
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

type AnyMessage = Log | Temp | Hello | IRKey | Weight | ButtonPressed | PingResult | RelayState;

export interface ClockControllerEvents {
    onDisconnect: () => void;
    onTemperatureChanged: (temp: number) => void;
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

export class ClockController extends ClassWithId implements Controller {
    protected pingId = 0;
    protected intervalId?: NodeJS.Timer;
    protected lastResponse = Date.now();
    private readonly _name: string;
    public readonly properties: Property<any>[];
    public get name() { return this._name; }
    public readonly lcdInformer?: LcdInformer;
    public readonly internalName: string;

    public tempProperty = new PropertyImpl<string>("Температура", new SpanHTMLRenderer(), "Нет данных");
    public weightProperty = new PropertyImpl<string>("Вес", new SpanHTMLRenderer(), "Нет данных");
    public screenEnabledProperty = newWritableProperty("Экран", true, new CheckboxHTMLRenderer(),
        (val: boolean) => {
            console.log("Sending screenEnable", val);
            this.send({ type: 'screenEnable', value: val });
        });
    public brightnessProperty = newWritableProperty("Яркость", 
        0,
        new SliderHTMLRenderer(),
        (val: number) => {
            this.send({ type: 'brightness', value: val });
        });
    private static baseW: Map<string, number> = new Map();
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
        this.baseWeight = ClockController.baseW.get(this._name);
        this.lastResponse = Date.now();

        this.properties = [];
        if (hello.devParams['hasHX711'] === 'true') {
            this.properties.push(this.weightProperty);
            this.properties.push(Button.create("Weight reset", () => this.tare()));
        }
        if (hello.devParams['hasDS18B20'] === 'true') {
            this.properties.push(this.tempProperty);
        }
        if (hello.devParams["hasScreen"] === 'true') {
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
            this.brightnessProperty.setInternal(+hello.devParams.brightness);
            this.screenEnabledProperty.setInternal(hello.screenEnabled || true);
            this.properties.push(this.screenEnabledProperty);
            this.properties.push(this.brightnessProperty);
            this.properties.push(newWritableProperty("Go play", "", new StringAndGoRendrer("Play"), (val) => {
                this.send({ type: 'show', text: val });
            }));
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
        }, 1500);

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
        switch (objData.type) {
            case 'pingresult':
                if (objData.vcc && objData.vcc != -1 && objData.vcc != 0xffff) {
                    console.log("VCC:", objData.vcc);
                }
                // console.log(this._name, objData.pingid);
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
            default:
                console.log(this + " UNKNOWN CMD: ", objData);
        }
    }
}
