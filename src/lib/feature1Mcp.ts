import { McpFetchResponse } from '../../shared/types';

export interface UserStory {
  id: string;
  code: string;
  title: string;
  status: string;
}

export interface BrowserLoginStart {
  loginUrl: string;
  loginId: string;
}

export function mcpBaseUrl(tenantSlug: string): string {
  return `https://${tenantSlug}-mcp.feature1.ai/mcp/`;
}

export function mcpHost(tenantSlug: string): string {
  return `${tenantSlug}-mcp.feature1.ai`;
}

export function tokenKeychainEntry(tenantSlug: string): string {
  return `feature1-mcp-${tenantSlug}`;
}

let rpcId = 0;

export class Feature1McpError extends Error {}

export class Feature1McpClient {
  constructor(
    private readonly tenantSlug: string,
    private readonly token: string | null
  ) {}

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const res: McpFetchResponse = await window.mvpfy.mcpFetch({
      url: mcpBaseUrl(this.tenantSlug),
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    if (!res.ok) {
      throw new Feature1McpError(
        res.error || `Feature1 MCP request failed (HTTP ${res.status}): ${res.body.slice(0, 300)}`
      );
    }
    let parsed: { result?: unknown; error?: { message?: string } };
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Feature1McpError(`Feature1 MCP returned non-JSON response: ${res.body.slice(0, 300)}`);
    }
    if (parsed.error) {
      throw new Feature1McpError(parsed.error.message || 'Feature1 MCP returned an error');
    }
    return parsed.result;
  }

  /**
   * Call an MCP tool and return its payload. Tool results arrive either as
   * structured JSON or as a text content block containing JSON.
   */
  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = (await this.rpc('tools/call', { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
    } | null;
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const text = result?.content?.find((c) => c.type === 'text')?.text;
    if (text === undefined) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // -- Auth ----------------------------------------------------------------

  async browserLogin(): Promise<BrowserLoginStart> {
    const raw = (await this.callTool('browser_login')) as Record<string, unknown>;
    const loginUrl = (raw?.login_url ?? raw?.loginUrl) as string | undefined;
    const loginId = (raw?.login_id ?? raw?.loginId) as string | undefined;
    if (!loginUrl || !loginId) {
      throw new Feature1McpError('browser_login did not return a login URL');
    }
    return { loginUrl, loginId };
  }

  /** Poll /login/status until the browser flow completes; resolves to the session token. */
  async pollLoginStatus(loginId: string, timeoutMs = 5 * 60_000): Promise<string> {
    const statusUrl = `https://${mcpHost(this.tenantSlug)}/login/status?login_id=${encodeURIComponent(loginId)}`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await window.mvpfy.mcpFetch({ url: statusUrl });
      if (res.ok) {
        try {
          const body = JSON.parse(res.body) as { status?: string; token?: string };
          if (body.status === 'complete' && body.token) return body.token;
          if (body.status === 'failed') throw new Feature1McpError('Browser login failed');
        } catch (err) {
          if (err instanceof Feature1McpError) throw err;
          // Non-JSON response while pending; keep polling.
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Feature1McpError('Timed out waiting for browser login');
  }

  // -- Workflow helpers ----------------------------------------------------

  loadWorkflow(sessionId: string): Promise<unknown> {
    return this.callTool('load_workflow', { session_id: sessionId });
  }

  getUserStory(sessionId: string): Promise<unknown> {
    return this.callTool('get_user_story', { session_id: sessionId });
  }

  markAllAcsInProgress(): Promise<unknown> {
    return this.callTool('mark_all_acs_in_progress');
  }

  generatePromptsForAllAcs(): Promise<unknown> {
    return this.callTool('generate_prompts_for_all_acs');
  }

  markAllAcsImplementationDone(): Promise<unknown> {
    return this.callTool('mark_all_acs_implementation_done');
  }

  markAllAcsApproved(): Promise<unknown> {
    return this.callTool('mark_all_acs_approved');
  }

  attachPr(prUrl: string): Promise<unknown> {
    return this.callTool('attach_pr', { pr_url: prUrl });
  }

  markReadyForTesting(): Promise<unknown> {
    return this.callTool('mark_ready_for_testing');
  }

  async listUserStories(): Promise<UserStory[]> {
    const raw = await this.callTool('list_user_stories');
    const items = Array.isArray(raw)
      ? raw
      : ((raw as { stories?: unknown[] })?.stories ?? []);
    return (items as Array<Record<string, unknown>>).map((s, i) => ({
      id: String(s.id ?? s.session_id ?? s.sessionId ?? `story-${i}`),
      code: String(s.code ?? s.story_code ?? s.key ?? ''),
      title: String(s.title ?? s.name ?? 'Untitled story'),
      status: String(s.status ?? 'unknown'),
    }));
  }
}
