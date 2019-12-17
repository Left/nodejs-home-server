
export interface Action {
    name: string;
    perform: () => Promise<void>;
}

type AsyncSettings<T> = {
    [P in keyof T]: { 
        get(): Promise<T[P]>, 
        set(val: T[P]): Promise<void> 
    };
}

export function proxify<T>(def: T): AsyncSettings<T> {
    return <AsyncSettings<T>> new Proxy({}, {
        get: (target: T, name: string) => {
            if (!(name in target)) {
                return new Promise((accept, reject) => {

                });
            }
            return new Promise((accept, reject) => {

            });
        }
    });
}