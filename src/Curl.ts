import * as https from 'https';
import * as http from 'http';
import * as url from "url";

export function get(_url: string): Promise<string> {
    return new Promise<string>((accept, decline) => {
        const u = new url.URL(_url);
            
        let options = {
            protocol: u.protocol,
            port: +u.port,
            path: u.pathname,
            host: u.host
        };
    
        (u.protocol.indexOf('https') != -1 ? https : http).get(options, (resp) => {
            if (resp.statusCode == 302 || resp.statusCode == 301) {
                get(resp.headers.location)
                    .then(data => accept(data))
                    .catch(err => decline(err));
            } else {
                let data = '';
        
                // A chunk of data has been recieved.
                resp.on('data', (chunk) => {
                    data += chunk;
                });
        
                // The whole response has been received. Print out the result.
                resp.on('end', () => {
                    accept(data);
                });
            }
        }).on("error", (err) => {
            decline(err);
        });    
    });
}