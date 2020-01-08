
export interface LcdInformer {
    runningLine(str: string, totalMsToShow: number): void;
    staticLine(str: string): void;
    additionalInfo(str: string): void;
}

export class CompositeLcdInformer implements LcdInformer {   
    private dynamicInformers: Map<string, LcdInformer> = new Map();

    public runningLine(str: string, totalMsToShow: number) {
        for (const inf of this.dynamicInformers.values()) {
            inf.runningLine(str, totalMsToShow);
        }
    }
    public staticLine(str: string) {
        for (const inf of this.dynamicInformers.values()) {
            inf.staticLine(str);
        }
    }

    public additionalInfo(str: string) {
        for (const inf of this.dynamicInformers.values()) {
            inf.additionalInfo(str);
        }
    }

    public all(): IterableIterator<LcdInformer> {
        return this.dynamicInformers.values();
    }

    public delete(ip: string): any {
        this.dynamicInformers.delete(ip);
    }

    public set(ip: string, lcdInformer: LcdInformer): any {
        this.dynamicInformers.set(ip, lcdInformer);
    }
}