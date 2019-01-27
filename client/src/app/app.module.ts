import { BrowserModule } from '@angular/platform-browser';
import { NgModule } from '@angular/core';
import { WSService } from './app.ws.service';
import { AppComponent } from './app.component';

@NgModule({
  declarations: [
    AppComponent
  ],
  imports: [
    BrowserModule
  ],
  providers: [
    WSService
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
