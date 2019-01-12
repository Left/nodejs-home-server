import * as events from "events";

export interface Property<T> {
    readonly id: string;
    readonly name: string;
    readonly available: boolean;
    get(): T;
    onChange(fn: () => void): void;

    readonly htmlRenderer: HTMLRederer<T>;
}

export interface HTMLRederer<T> {
    body(prop: Property<T>): string;
    updateCode(prop: Property<T>): string;
}

export function voidHTMLRenderer<T>(): HTMLRederer<T> {
    return {
        body(prop: Property<T>): string { return ""; },
        updateCode(prop: Property<T>): string { return " "}
    };
}

export class CheckboxHTMLRenderer implements HTMLRederer<boolean> {
    body(prop: Property<boolean>): string {
        return `<label><input type="checkbox" id=${prop.id} 
            ${prop.available ? "" : "disabled"} 
            ${prop.get() ? "checked" : ""}
            onclick="sendVal('${prop.id}', '${prop.name}', document.getElementById('${prop.id}').checked)"/>${prop.name}</label>`;
    }    
    
    updateCode(prop: Property<boolean>): string {
        return `document.getElementById('${prop.id}').checked = val;`;
    }
}

export class ButtonRendrer implements HTMLRederer<void> {
    body(prop: Property<void>): string {
        return `<input ${prop.available ? "" : "disabled"}  type="button" id="${prop.id}" value="${prop.name}" 
            onclick="sendVal('${prop.id}', '${prop.name}', '')"></input>`;
    }

    updateCode(prop: Property<void>): string {
        return '';
    }
}

export class SliderHTMLRenderer implements HTMLRederer<number> {
    body(prop: Property<number>): string {
        return `<label>${prop.name}<input ${prop.available ? "" : "disabled"}  type="range" id="${prop.id}" min="0" max="100" value="${prop.get()}" 
            name="${prop.name}"
            oninput="sendVal('${prop.id}', '${prop.name}', +document.getElementById('${prop.id}').value)"/></label>`;
    }

    updateCode(prop: Property<number>): string {
        return `document.getElementById('${prop.id}').value = val;`;
    }
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
}

export class SpanHTMLRenderer implements HTMLRederer<string> {
    body(prop: Property<string>): string {
        return `<span id="${prop.id}">${this.propName(prop)}${prop.get()}</span>`;
    }

    updateCode(prop: Property<string>): string {
        return `document.getElementById('${prop.id}').innerHTML = '${this.propName(prop)}' + val;`;
    }

    propName(prop: Property<string>): string {
        return prop.name ? (prop.name + ': ') : ""
    }
}

export class StringAndGoRendrer implements HTMLRederer<string> {
    constructor(public readonly btnText: string) {}

    body(prop: Property<string>): string {
        return `<span>
            <input ${prop.available ? "" : "disabled"}  type="text" 
            id="${prop.id}" 
            placeholder="${prop.name}"
            value="" />&nbsp;
            <input type="button" value=" ${this.btnText} " onclick="sendVal('${prop.id}', '${prop.name}', document.getElementById('${prop.id}').value)"/>
            </span>`;
    }

    updateCode(prop: Property<string>): string {
        return '';
    }
}

export interface WritableProperty<T> extends Property<T> {
    set(val: T): void;
}

export function isWriteableProperty<T>(object: Property<T>): object is WritableProperty<T> {
    return 'set' in object;
}

export interface Controller {
    readonly name: string;
    readonly online: boolean;
    readonly properties: Property<any>[];
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

export class PropertyImpl<T> extends ClassWithId implements Property<T> {
    protected evs: events.EventEmitter = new events.EventEmitter();
    private _val: T;

    constructor(public readonly name: string, public readonly htmlRenderer: HTMLRederer<T>, readonly initial: T) {
        super();
        this._val = initial;
    }

    get available(): boolean {
        return true;
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

    onChange(fn: () => void): void {
        // TODO: Impl me
        this.evs.on('change', fn);
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
    onSet: (v:T)=>void = ()=>{}): WritablePropertyImpl<T> {
    return new (class WP extends WritablePropertyImpl<T> {
        set(val: T): void {
            this.setInternal(val);
            onSet(val);
        }
    })(name, htmlRenderer, initial);
}
