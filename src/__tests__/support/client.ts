import * as acp from '@agentclientprotocol/sdk'

/** The client callbacks the tests implement, in the shape the removed `Client` interface had. */
export interface Client {
  requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>
  sessionUpdate(params: acp.SessionNotification): Promise<void>
  readTextFile?(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>
  writeTextFile?(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>
}

/** Test stand-in for the removed `ClientSideConnection`, built on `client().connect`. */
export function connectClient(impl: Client, stream: acp.Stream) {
  let app = acp
    .client()
    .onRequest('session/request_permission', ({ params }) => impl.requestPermission(params))
    .onNotification('session/update', ({ params }) => impl.sessionUpdate(params))
  if (impl.readTextFile) app = app.onRequest('fs/read_text_file', ({ params }) => impl.readTextFile!(params))
  if (impl.writeTextFile) {
    app = app.onRequest('fs/write_text_file', async ({ params }) => (await impl.writeTextFile!(params)) ?? {})
  }

  const connection = app.connect(stream)
  const agent = connection.agent
  return {
    connection,
    initialize: (params: acp.InitializeRequest) => agent.request('initialize', params),
    newSession: (params: acp.NewSessionRequest) => agent.request('session/new', params),
    loadSession: (params: acp.LoadSessionRequest) => agent.request('session/load', params),
    resumeSession: (params: acp.ResumeSessionRequest) => agent.request('session/resume', params),
    listSessions: (params: acp.ListSessionsRequest) => agent.request('session/list', params),
    closeSession: (params: acp.CloseSessionRequest) => agent.request('session/close', params),
    prompt: (params: acp.PromptRequest) => agent.request('session/prompt', params),
    cancel: (params: acp.CancelNotification) => agent.notify('session/cancel', params),
  }
}

export type ClientConnection = ReturnType<typeof connectClient>
