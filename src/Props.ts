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

export class CheckboxHTMLRenderer implements HTMLRederer<boolean> {
    body(prop: Property<boolean>): string {
        return `<label><input type="checkbox" id=${prop.id} 
            ${prop.available ? "" : "disabled"} 
            ${prop.get() ? "checked" : ""}
            onclick="sendVal('${prop.id}', document.getElementById('${prop.id}').checked)"/>${prop.name}</label>`;
    }    
    
    updateCode(prop: Property<boolean>): string {
        return `document.getElementById('${prop.id}').checked = val;`;
    }
}

export class ButtonRendrer implements HTMLRederer<void> {
    body(prop: Property<void>): string {
        return `<input ${prop.available ? "" : "disabled"}  type="button" id="${prop.id}" value="${prop.name}" 
            onclick="sendVal('${prop.id}', '')"></input>`;
    }

    updateCode(prop: Property<void>): string {
        return '';
    }
}

export class SliderHTMLRenderer implements HTMLRederer<number> {
    body(prop: Property<number>): string {
        return `<label>${prop.name}<input ${prop.available ? "" : "disabled"}  type="range" id="${prop.id}" min="0" max="100" value="${prop.get()}" 
            oninput="sendVal('${prop.id}', +document.getElementById('${prop.id}').value)"/></label>`;
    }

    updateCode(prop: Property<number>): string {
        return `document.getElementById('${prop.id}').value = val;`;
    }
}

export class SpanHTMLRenderer implements HTMLRederer<string> {
    body(prop: Property<string>): string {
        return `<span id="${prop.id}">${prop.name} : ${prop.get()}</span>`;
    }

    updateCode(prop: Property<string>): string {
        return `document.getElementById('${prop.id}').innerHTML = '${prop.name + ' :'}' + val;`;
    }
}

export interface WriteableProperty<T> extends Property<T> {
    set(val: T): void;
}

export function isWriteableProperty<T>(object: Property<T>): object is WriteableProperty<T> {
    return 'set' in object;
}

export interface Controller {
    readonly name: string;
    readonly online: boolean;
    readonly properties: Property<any>[];
}

export class PropertyImpl<T> implements Property<T> {
    private static _nextId = 0;
    private static _allProps = new Map<string, Property<any>>();

    protected evs: events.EventEmitter = new events.EventEmitter();
    private _val: T;
    public readonly id: string;

    constructor(public readonly name: string, public readonly htmlRenderer: HTMLRederer<T>, readonly initial: T) {
        this._val = initial;
        this.id = ("" + (PropertyImpl._nextId++) + "(" + this.name + ")");
        PropertyImpl._allProps.set(this.id, this);
    }

    static byId(id: string): Property<any>|undefined {
        return PropertyImpl._allProps.get(id);
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

export abstract class WritablePropertyImpl<T> extends PropertyImpl<T> implements WriteableProperty<T> {
    constructor(public readonly name: string, readonly htmlRenderer: HTMLRederer<T>, readonly initial: T) {
        super(name, htmlRenderer, initial);
    }

    abstract set(val: T): void;
} 
