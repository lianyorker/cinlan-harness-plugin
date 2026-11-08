export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogFields {
    [key: string]: unknown;
}
export interface Logger {
    debug(event: string, message: string, data?: LogFields): void;
    info(event: string, message: string, data?: LogFields): void;
    warn(event: string, message: string, data?: LogFields): void;
    error(event: string, message: string, data?: LogFields): void;
    close(): void;
}
export interface LoggerOptions {
    component: string;
    level?: LogLevel;
    /** JSONL 文件路径；缺省只写控制台 */
    filePath?: string;
    /** 关闭控制台输出（demo 断言时避免刷屏） */
    quiet?: boolean;
}
export declare function createLogger(opts: LoggerOptions): Logger;
/** 生成按日期滚动的日志文件路径：<dir>/<name>-YYYYMMDD.log */
export declare function logFilePathFor(dir: string, name: string, date?: Date): string;
export declare function ensureLogDir(dir: string): Promise<void>;
