import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowCodeStats } from '../types.js';

export interface RpcClientOptions {
  workdir: string;
  port?: number;
  dataDir?: string;
}

export class KnowCodeRpcClient {
  private basePort: number;

  constructor(private options: RpcClientOptions) {
    this.basePort = options.port ?? 48123;
  }

  /**
   * Determine the active port from .knowcode/daemon.json or default
   */
  public getActivePort(): number {
    const dataDir = join(this.options.workdir, this.options.dataDir ?? '.knowcode');
    const infoPath = join(dataDir, 'daemon.json');
    if (existsSync(infoPath)) {
      try {
        const info = JSON.parse(readFileSync(infoPath, 'utf8'));
        if (info.port) return info.port;
      } catch {}
    }
    return this.basePort;
  }

  /**
   * Check if daemon is active and responding
   */
  public async isDaemonAlive(): Promise<boolean> {
    const port = this.getActivePort();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get stats from daemon
   */
  public async getStatus(): Promise<KnowCodeStats> {
    const port = this.getActivePort();
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Failed to fetch status: ${res.statusText}`);
    return (await res.json()) as KnowCodeStats;
  }

  /**
   * Call a tool action via daemon RPC
   */
  public async call(action: string, params: Record<string, any> = {}): Promise<any> {
    const port = this.getActivePort();
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`RPC call failed (${res.status}): ${err}`);
    }
    return await res.json();
  }

  /**
   * Run raw Cypher query
   */
  public async query(cypher: string, params?: Record<string, any>): Promise<any> {
    const port = this.getActivePort();
    const res = await fetch(`http://127.0.0.1:${port}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cypher, params }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Cypher query failed: ${err}`);
    }
    return await res.json();
  }

  /**
   * Trigger index
   */
  public async triggerIndex(targetPath?: string): Promise<any> {
    const port = this.getActivePort();
    const res = await fetch(`http://127.0.0.1:${port}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Indexing failed: ${err}`);
    }
    return await res.json();
  }

  /**
   * Request daemon shutdown
   */
  public async shutdown(): Promise<void> {
    const port = this.getActivePort();
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
}
