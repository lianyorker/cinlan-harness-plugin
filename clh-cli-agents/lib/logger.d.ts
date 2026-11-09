export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
    readonly level: LogLevel;
    debug(event: string, message: string, data?: unknown): void;
    info(event: string, message: string, data?: unknown): void;
    warn(event: string, message: string, data?: unknown): void;
    error(event: string, message: string, data?: unknown): void;
}
export interface LoggerOptions {
    component: string;
    level: LogLevel;
    /** 给了就向该文件追加 JSONL（目录不存在会自动创建）；写失败只吞掉，不影响主流程。 */
    filePath?: string;
    /** 输出通道：stdout（默认，harness 抓插件日志）或 stderr（CLI：结果走 stdout、日志走 stderr） */
    channel?: 'stdout' | 'stderr';
}
export declare function ensureLogDir(filePath: string): Promise<void>;
export declare function logFilePathFor(dir: string, name: string): string;
export declare function createLogger(options: LoggerOptions): Logger;
