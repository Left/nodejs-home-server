import * as events from "events";

export interface Property<T> {
    readonly id: string;
    readonly name: string;
    get(): T;
    onChange(fn: () => void): Disposable;
    readonly htmlRenderer: HTMLRederer<T>;
}

export interface HTMLRederer<T> {
    body(prop: Property<T>): string;
    updateCode(prop: Property<T>): string;
    toHtmlVal(t: T): any;
}

export function voidHTMLRenderer<T>(): HTMLRederer<T> {
    return {
        body(prop: Property<T>): string { return ""; },
        updateCode(prop: Property<T>): string { return " "},
        toHtmlVal(t: T): any { return t; }
    };
}

export class CheckboxHTMLRenderer implements HTMLRederer<boolean> {
    body(prop: Property<boolean>): string {
        return `<label><input type="checkbox" id=${prop.id} 
            ${prop.get() ? "checked" : ""}
            onclick="sendVal('${prop.id}', '${prop.name}', document.getElementById('${prop.id}').checked)"/>${prop.name}</label>`;
    }    
    
    updateCode(prop: Property<boolean>): string {
        return `document.getElementById('${prop.id}').checked = val;`;
    }

    toHtmlVal(t: boolean): any { return t; }
}

export class ButtonRendrer implements HTMLRederer<void> {
    constructor(private onclickAction = (prop: Property<void>) => `sendVal('${prop.id}', '${prop.name}', '')`) {
    }

    body(prop: Property<void>): string {
        return `<input type="button" id="${prop.id}" value="${prop.name}" 
            onclick="${this.onclickAction(prop)}"></input>`;
    }

    updateCode(prop: Property<void>): string {
        return '';
    }

    toHtmlVal(t: void): any { return t; }
}

export class SliderHTMLRenderer implements HTMLRederer<number> {
    body(prop: Property<number>): string {
        return `<label>${prop.name}<input type="range" id="${prop.id}" min="0" max="100" value="${prop.get()}" 
            name="${prop.name}"
            oninput="sendVal('${prop.id}', '${prop.name}', +document.getElementById('${prop.id}').value)"/></label>`;
    }

    updateCode(prop: Property<number>): string {
        return `document.getElementById('${prop.id}').value = val;`;
    }

    toHtmlVal(t: number): any { return t; }
}

export class SelectHTMLRenderer<T> implements HTMLRederer<T> {
    constructor(
        public readonly choices: T[], 
        public readonly valToText: (t:T) => string = (x => x.toString())
    ) {
    }

    body(prop: Property<T>): string {
        return `<label>${prop.name}
            <select id='${prop.id}' name="${prop.name}"
                onchange="sendVal('${prop.id}', '${prop.name}', +document.getElementById('${prop.id}').selectedOptions[0].value)">
                ${this.choices.map(v => `<option ${prop.get() === v ? 'selected' : ''} value=${v}>${this.valToText(v)}</option>`).join('')}
            </select>
            </label>`;
    }

    updateCode(prop: Property<T>): string {
        return `Array.from(document.getElementById('${prop.id}').options).forEach((o, i) => { if (o.value == val) document.getElementById('${prop.id}').selectedIndex = i })`;
    }

    toHtmlVal(t: T): any { return t; }
}

export class ImgHTMLRenderer implements HTMLRederer<string> {
    constructor(private w: number, private h: number) {
    }

    body(prop: Property<string>): string {
        return `<img id="${prop.id}" src="${prop.get()}" style="max-width:${this.w}px; max-height:${this.h}px; width:auto; height:auto; vertical-align: middle;"/></span>`;
    }

    updateCode(prop: Property<string>): string {
        return `document.getElementById('${prop.id}').src = val;`;
    }

    propName(prop: Property<string>): string {
        return ""
    }

    toHtmlVal(t: string): any { return t; }
}

export class SpanHTMLRenderer<T> implements HTMLRederer<T> {
    constructor(private tostr: (t:T) => string = (t) => t.toString()) {
    }

    toHtmlVal(val: T) {
        return this.tostr(val);
    }

    body(prop: Property<T>): string {
        return `<span id="${prop.id}">${this.propName(prop)}${this.tostr(prop.get())}</span>`;
    }

    updateCode(prop: Property<T>): string {
        return `document.getElementById('${prop.id}').innerHTML = '${this.propName(prop)}' + val;`;
    }

    propName(prop: Property<T>): string {
        return prop.name ? (prop.name + ': ') : ""
    }
}

export class StringAndGoRendrer implements HTMLRederer<string> {
    constructor(public readonly btnText: string) {}

    body(prop: Property<string>): string {
        return `<label>${prop.name}
            <input type="text" 
            id="${prop.id}" 
            value="${prop.get()}" />&nbsp;
            <input type="button" value=" ${this.btnText} " onclick="sendVal('${prop.id}', '${prop.name}', document.getElementById('${prop.id}').value)"/>
            </label>`;
    }

    updateCode(prop: Property<string>): string {
        return `document.getElementById('${prop.id}').value = val;`;
    }

    toHtmlVal(t: string): any { return t; }
}

export interface WritableProperty<T> extends Property<T> {
    set(val: T): void;
}

export function isWriteableProperty<T>(object: Property<T>): object is WritableProperty<T> {
    return 'set' in object;
}

export interface Controller {
    readonly name: string;
    properties(): Property<any>[];
}

export class ClassWithId {
    private static _nextId = 0;
    private static _allProps = new Map<string, any>();
    public readonly id: string;

    constructor() {
        this.id = ("" + (PropertyImpl._nextId++));
        PropertyImpl._allProps.set(this.id, this);
    }

    static byId<T>(id: string): T {
        return PropertyImpl._allProps.get(id) as T;
    }
}

export interface Disposable {
    dispose(): void;
}

export class PropertyImpl<T> extends ClassWithId implements Property<T> {
    protected evs: events.EventEmitter = new events.EventEmitter();
    private _val: T;

    constructor(public readonly name: string, public readonly htmlRenderer: HTMLRederer<T>, readonly initial: T) {
        super();
        this._val = initial;
    }

    get(): T {
        return this._val;
    }

    public setInternal(val: T) {
        const shouldFire = this._val != val;
        this._val = val;
        if (shouldFire) {
            this.fireOnChange();
        }
    }

    onChange(fn: () => void): Disposable {
        // TODO: Impl me
        this.evs.on('change', fn);
        return {
            dispose: () => {
                this.evs.removeListener('change', fn);
            }
        };
    }

    protected fireOnChange() {
        this.evs.emit('change');
    }
}

export abstract class WritablePropertyImpl<T> extends PropertyImpl<T> implements WritableProperty<T> {
    constructor(public readonly name: string, readonly htmlRenderer: HTMLRederer<T>, readonly initial: T) {
        super(name, htmlRenderer, initial);
    }

    abstract set(val: T): void;
} 

export function newWritableProperty<T>(
    name: string, 
    initial: T, 
    htmlRenderer: HTMLRederer<T> = voidHTMLRenderer(), 
    handlers: { 
        init?(_this: WritablePropertyImpl<T>): void;
        onSet?(v:T, oldV:T): void;
        preSet?(v:T): T;
    } = {}): WritablePropertyImpl<T> {

    return new (class WP extends WritablePropertyImpl<T> {
        constructor() {
            super(name, htmlRenderer, initial);
            if (handlers.init) { 
                handlers.init(this);
            }
        }

        set(val: T): void {
            if (handlers.preSet) {
                val = handlers.preSet(val);
            }
            const oldVal = this.get();
            this.setInternal(val);
            if (handlers.onSet) { 
                handlers.onSet(val, oldVal);
            }
        }
    })();
}

export class Button extends WritablePropertyImpl<void> {
    constructor(name: string, 
        private action: () => void,
        renderer: HTMLRederer<void> = new ButtonRendrer()) {
        super(name, renderer, void 0);
    }

    set(val: void): void {
        this.action();
    }

    static create(name: string, action: () => void): Button {
        return new Button(name, action);
    }

    static createClientRedirect(name: string, url: string): Button {
        return new Button(name, () => {}, new ButtonRendrer(() => "location = ('" + url + "')"));
    }

    static createCopyToClipboard(name: string, value: string): Button {
        return new Button(name, () => {}, new ButtonRendrer(() => "copyToClipboard('" + value + "')"));
    }

    static createCopyToClipboardLambda(name: string, value: () => string): Button {
        return new Button(name, () => {}, new ButtonRendrer(() => "copyToClipboard('" + value() + "')"));
    }
}

export interface OnOff {
    readonly name: string;
    get(): boolean;
    switch(on: boolean): Promise<void>;
}

export abstract class Relay extends WritablePropertyImpl<boolean> {
    constructor(readonly name: string) {
        super(name, new CheckboxHTMLRenderer(), false);
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
