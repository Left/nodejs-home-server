import { WebSocketSubject } from 'rxjs/observable/dom/WebSocketSubject';

interface ServerVersion {
  type: 'serverVersion';
  val: string;
}

interface GetPropList {
    type: 'getPropList';
}

type Message = ServerVersion | GetPropList;

export class WSService {
    private oldServerVersion?: string;
    private socket$: WebSocketSubject<Message>;
  
    initsocketCommunications(): any {
      this.socket$ = new WebSocketSubject<Message>({
        url: 'ws://' + location.host + '/web',
        openObserver: {
          next: (value) => {
            // console.log(value);
            this.socket$.next({
                type: 'getPropList'
            });
          }
        }
      });
  
      this.socket$
        .subscribe(
          (message) => {
            if (message.type === 'serverVersion') {
              if (!!this.oldServerVersion && this.oldServerVersion !== message.val) {
                location.reload();
              } else {
                this.oldServerVersion = message.val;
              }
            }
          },
          (err) => {
            console.error(err)
            setTimeout(() => this.initsocketCommunications(), 1000);
          },
          () => { 
            console.warn('Completed!');
            setTimeout(() => this.initsocketCommunications(), 1000);
          }
        );
    }  
}