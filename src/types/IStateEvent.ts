import { IRoomEvent } from "./IRoomEvent";
import { IContent } from "../models/event";

export interface IStateEvent extends IRoomEvent {
    prev_content?: IContent;
    state_key: string;
}
