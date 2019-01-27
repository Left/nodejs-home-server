import { Component } from '@angular/core';
import { WSService } from './app.ws.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  public title = 'Home server';

  constructor(private wsService: WSService) {
    this.wsService.initsocketCommunications();
  }

}
