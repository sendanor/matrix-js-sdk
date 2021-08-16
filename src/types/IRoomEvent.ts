import { IMinimalEvent } from "./IMinimalEvent";
import { IUnsigned } from "../models/event";

export interface IRoomEvent extends IMinimalEvent {
    event_id: string;
    sender: string;
    origin_server_ts: number;
    unsigned?: IUnsigned;
    /** @deprecated - legacy field */
    age?: number;
}
