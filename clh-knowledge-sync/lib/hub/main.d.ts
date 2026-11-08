import { type HubConfig } from '../config.js';
import { type HubRuntime } from './server.js';
export declare function startHub(cfg: HubConfig): Promise<HubRuntime>;
export declare function runHubCli(argv: string[]): Promise<number>;
