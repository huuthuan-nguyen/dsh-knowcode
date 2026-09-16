export interface ExecutionResult {
    kind: 'knowcode';
    action: string;
    content: string;
    raw?: any;
}
export declare function executeKnowCodeTool(rawAction: string, args: any, workdir: string, daemonPort?: number): Promise<ExecutionResult>;
