import { IContent } from "../models/event";
import { EventType } from "../@types/event";

export interface IMinimalEvent {
    content: IContent;
    type: EventType | string;
}
