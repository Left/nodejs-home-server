
export interface Action {
    name: string;
    perform: () => Promise<void>;
}