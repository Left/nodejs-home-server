import * as curl from "./http.util";

const GS_earliest_date = new Date(1899, 11, 30).getTime();
const denominator = 24*60*60*1000;

function parseDate(d: number): Date {
    return new Date(d*denominator + GS_earliest_date);
} 
function unparseDate(d: Date): number {
    return (d.getTime() - GS_earliest_date)/denominator;
}

export async function addPullup(apiKey: string) {
    const sshid = "1VU9XPWTJm3gA1OjzNJCSiOEDFa2vBTplvRh0SN4MQiU";
    function getUrl(action: string) {
        return "https://sheets.googleapis.com/v4/spreadsheets/" + sshid + 
            "/" + action + "?key=" + apiKey
    }
    const url = getUrl("values:batchGet") + "&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&" + 
        "ranges=A2:A1000&majorDimension=COLUMNS"
    const dates = await curl.get(url)
    const d = JSON.parse(dates);
    if (!("error" in d)) {
        const dates: number[] = d.valueRanges[0].values[0];
        const lastVal = parseDate(dates[dates.length-1]);
        const now = new Date()
        // console.log(unparseDate(now), unparseDate(lastVal));
        var ind;

        if ((now.getTime() - lastVal.getTime()) < 60*1000) {
            // Less than a minute, let's inc existing
            ind = dates.length + 1
        } else {
            // Add new date
            ind = dates.length + 2
        }
        const addr = "A" + ind;
        console.log("WRITING TO", addr);

        const d2 = await curl.get(
            getUrl("values/Sheet1!" + addr + ":" + addr),
            "PUT",
            JSON.stringify({
                range: addr + ":" + addr,
                majorDimension: "ROWS",
                values: [
                    1
                ]
            }),)

        console.log(d2);
    } else {
        throw "Can't save data"
    }
}