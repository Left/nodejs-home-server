
export interface Changeable<T> {
    whenChanged(): Promise<void>;
    get(): T;
    id(): string;
}

export interface AProp<T, S=T> extends Changeable<T> {
    set(v: S): void;
}

export abstract class HTML implements Changeable<string> {
    public abstract whenChanged(): Promise<void>;
    public abstract get(): string;
    public abstract id(): string;
}

export type ToStringFunc<T> = (v:T) => string;

export class Span<T> extends HTML {
    constructor(private prop: Changeable<T>, private toStr: ToStringFunc<T> = (v:T) => v.toString()) {
        super();
    }

    public get(): string {
        return `<span id='${this.id()}'>${this.toStr(this.prop.get())}</span>`;
    }

    public whenChanged(): Promise<void> {
        return this.prop.whenChanged();
    }

    public id(): string {
        return "span." + this.prop.id();
    }
}

type WaitForChangeResult = void;

export function waitForAnyChange<T>(vals: Changeable<Changeable<T>[]>): Promise<WaitForChangeResult> {
    const prevValue = vals.get();

    return Promise.race(
        Array.prototype.concat(
            vals.get().map(html => html.whenChanged().then(v => {
                // this promise has been changed. Let's process it
                return html.get();
            })),
            vals.whenChanged().then(() => {
                const prevMap: Map<string, [Changeable<T>, number]> = 
                    new Map(prevValue.map((e, ind) => [e.id(), [e, ind]]));
                const now = vals.get();
                now.forEach((e, ind) => {
                    const prev = prevMap.get(e.id());
                    if (prev) {
                        // Was in prev
                        const oldItem = prev[0];
                        const oldIndex = prev[1];

                        prevMap.delete(e.id());
                    } else {
                        // New item
                        const newItem = e;
                    }
                });
                prevMap.forEach(ent => {
                    const deletedEntry = ent[0];
                    const deletedIndex = ent[1];
                });
        
                // Property list was changed
                return vals.get().map(html => html.get());
            })
        )
    );
}

export function generate(content: Changeable<HTML[]>): string {
    const workingLoop = async () => {
/*
        const signalled: string = await waitForAnyChange<HTML>(content);
        
        return resNow;
*/
    };
    
    return "";
}

