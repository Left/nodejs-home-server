import * as curl from "./http.util";
import * as url from "url";

interface YoutubeTrack {
    title: string;
    thumbnailUrl: string;
}

export type UrlsInfo = { id: string };
const idsCache: Map<string, UrlsInfo> = new Map();

export function parseYoutubeUrl(_url: string): UrlsInfo|undefined {
    if (idsCache.has(_url)) {
        return idsCache.get(_url);
    }

    try {
        const u = new url.URL(_url);
        var ytbId: string|null|undefined;
        if (u.hostname === 'www.youtube.com') {
            ytbId = u.searchParams.get('v');
        } else if (u.hostname === 'youtu.be') {
            ytbId = u.pathname.split('/').filter(x => !!x)[0];
        }
        if (!!ytbId) {
            const toRet = { id: ytbId };
            idsCache.set(_url, toRet);
            return toRet;
        }
        return undefined;    
    } catch (e) {
        return undefined;
    }
}

export function getYoutubeInfo(_url: string, youtubeApiKey: string): Promise<YoutubeTrack> {
    const ytbInfo = parseYoutubeUrl(_url);

    if (ytbInfo) {
        return getYoutubeInfoById(ytbInfo.id, youtubeApiKey);
    } else {
        return Promise.reject(new Error("Invalid (non-youtube) URL: " + _url));
    }
}

const tracksCache: Map<string, YoutubeTrack> = new Map();

export function getYoutubeInfoById(ytbId: string, youtubeApiKey: string): Promise<YoutubeTrack> {
    if (tracksCache.has(ytbId)) {
        return Promise.resolve(tracksCache.get(ytbId)!);
    }

    return new Promise<YoutubeTrack>((accept, decline) => {
        curl.get("https://www.googleapis.com/youtube/v3/videos?part=id%2C+snippet&key=" + youtubeApiKey + "&id=" + ytbId)
            .then(text => {
                const dd = JSON.parse(text);
                const snippet = dd.items[0]["snippet"];
                const ret = {
                    title: snippet.title,
                    thumbnailUrl: snippet.thumbnails.default.url
                };
                tracksCache.set(ytbId, ret);
                accept(ret);
            })
            .catch((err) => {
                return decline(err);
            });
    });
}