# CodeSymphony Workspace

> Local-first AI coding workspace powered by Claude Agent SDK

A conductor.build-style development environment that combines repository management, Git worktrees, and threaded Claude conversations into a unified IDE-like interface.

## ✨ Features

- **🗂️ Repository Management** - Onboard local repositories and manage Git worktrees
- **💬 AI-Powered Chat** - Threaded Claude sessions with real-time streaming
- **🔧 Tool Execution** - Watch Claude use development tools with live progress updates
- **🎯 Permission Control** - Approve or deny tool executions before they run
- **🌐 Local-First Architecture** - Web client with optional desktop shell (Tauri)
- **📊 Event Timeline** - Visual history of all actions, thoughts, and tool calls
- **🔄 SSE Streaming** - Real-time updates without polling

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Web/Desktop Client                   │
│              (React 19 + Vite + Tailwind)                │
└────────────────────┬────────────────────────────────────┘
                     │ REST + SSE
                     ▼
┌─────────────────────────────────────────────────────────┐
│                    Runtime API Server                    │
│              (Fastify + Prisma + SQLite)                 │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │   Claude    │  │   Event      │  │    Git         │  │
│  │  Agent SDK  │  │    Hub       │  │  Worktrees     │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Project Structure

- **`apps/runtime`** - Fastify API server with Claude Agent SDK integration
- **`apps/web`** - React UI with chat panel, repository sidebar, and terminal
- **`apps/desktop`** - Tauri shell for desktop packaging
- **`packages/shared-types`** - Zod schemas and TypeScript types for API contracts
- **`packages/orchestrator-core`** - Run state machine utility

### Technology Stack

| Component | Technology |
|-----------|-----------|
| Backend | Fastify, Prisma, SQLite |
| Frontend | React 19, Vite, Tailwind CSS, Radix UI |
| AI | Claude Agent SDK |
| Desktop | Tauri (Rust) |
| Build | Turbo, pnpm workspaces |

## 🚀 Quick Start

### Prerequisites

- **Node.js** 22+
- **pnpm** 10+
- **Git** (installed and in PATH)
- **Claude Code CLI** - Install and authenticate with `claude login`

Optional (for desktop):
- **Rust + Cargo** + Tauri prerequisites

### Installation

1. **Clone and install dependencies:**

```bash
git clone <repository-url>
cd west-nusa-tenggara
pnpm install
```

2. **Configure runtime environment:**

```bash
cp apps/runtime/.env.example apps/runtime/.env
```

Edit `apps/runtime/.env`:

```env
RUNTIME_HOST=0.0.0.0
RUNTIME_PORT=4331
DATABASE_URL="file:./prisma/dev.db"
CLAUDE_CODE_EXECUTABLE=claude
WORKTREE_ROOT="~/.codesymphony/worktrees"
```

3. **Initialize database:**

```bash
pnpm db:generate && pnpm db:migrate && pnpm db:seed
```

### Development

Start the full development stack (web + runtime):

```bash
pnpm dev
# or
make dev
```

Access the application:
- **Web UI**: http://127.0.0.1:5173
- **Runtime API**: http://127.0.0.1:4331

Individual services:

```bash
pnpm dev:runtime    # Backend only
pnpm dev:web        # Frontend only
pnpm dev:desktop    # Desktop shell
```

### Building

```bash
pnpm build          # Build all workspaces
pnpm --filter @codesymphony/web build
pnpm --filter @codesymphony/runtime build
```

## 📖 Usage

### Basic Workflow

1. **Add a Repository**
   - Click "Add Repository" in the sidebar
   - Browse or enter local filesystem path

2. **Create a Worktree**
   - Select your repository
   - Click "Create Worktree" to make an isolated branch workspace

3. **Start a Chat Thread**
   - Select your worktree
   - Create a new chat thread or open existing one

4. **Interact with Claude**
   - Send prompts and receive real-time responses
   - Approve tool executions when prompted
   - Watch the event timeline for detailed progress

### Permission System

Claude will request permission before:
- Running shell commands
- Writing/deleting files
- Executing potentially destructive operations

You can **Approve** or **Deny** each request, and decisions are persisted in the event history.

## 🐳 Docker Deployment

Run web + runtime together with Docker Compose:

```bash
pnpm docker:up
```

Access:
- **Web**: http://127.0.0.1:5173
- **Runtime**: http://127.0.0.1:4321

Stop services:

```bash
pnpm docker:down
```

**Docker Notes:**
- macOS folder picker unavailable - use manual path input
- Host directory mounted to `/workspace/repos`
- Worktrees and database persisted in Docker volume
- Use `/workspace/repos` to reference the mounted project

## 🧪 Testing

Run all tests:

```bash
pnpm test
```

Run specific workspace tests:

```bash
pnpm --filter @codesymphony/runtime test
pnpm --filter @codesymphony/web test
```

Run specific test file:

```bash
pnpm --filter @codesymphony/runtime test -- chatService.permissions.test.ts
```

Type checking:

```bash
pnpm lint
```

## 🔌 API Reference

Base URL: `http://127.0.0.1:4331/api`

### Repositories

- `GET /repositories` - List all repositories
- `GET /repositories/:id` - Get repository details
- `POST /repositories` - Add repository by path

### Worktrees

- `POST /repositories/:id/worktrees` - Create worktree branch
- `GET /worktrees/:id` - Get worktree details
- `DELETE /worktrees/:id` - Delete worktree

### Chat Threads

- `GET /worktrees/:id/threads` - List threads in worktree
- `POST /worktrees/:id/threads` - Create new thread
- `GET /threads/:id` - Get thread details
- `GET /threads/:id/messages` - List messages in thread
- `POST /threads/:id/messages` - Send message to Claude

### Permissions

- `POST /threads/:id/permissions/resolve` - Approve/deny permission request

### Events

- `GET /threads/:id/events` - Get event history
- `GET /threads/:id/events/stream` - SSE stream for live events

### System

- `GET /debug/runtime-info` - Runtime diagnostic information
- `GET /health` - Health check

## 🛠️ Makefile Shortcuts

```bash
make help        # Show all available commands
make install     # Install dependencies
make dev         # Start dev servers (web + runtime)
make dev-runtime # Start runtime only
make dev-web     # Start web only
make db-init     # Initialize database (generate + migrate + seed)
make lint        # Run TypeScript type checking
make test        # Run all tests
make build       # Build all workspaces
```

## 🐛 Debugging

### Client-Side Debug Logging

The web app includes client-to-server debug logging for diagnosing browser issues:

```javascript
// In browser console
copy(JSON.stringify(window.__CS_DEBUG_LOG__.slice(0, 200), null, 2))
```

Logs are sent to `apps/runtime/debug.log` via `navigator.sendBeacon`.

To add debug logging:
```typescript
import { debugLog } from '@/lib/debugLog';

debugLog("source", "message", data);
```

## 📦 Database

Database files by environment:
- **Development**: `apps/runtime/prisma/dev.db`
- **Testing**: `apps/runtime/prisma/test.db`
- **Desktop**: `apps/runtime/prisma/desktop.db`

Schema is managed via Prisma migrations in `apps/runtime/prisma/schema.prisma`.

## 🤝 Contributing

1. Follow the code conventions outlined in `CLAUDE.md`
2. Write tests for new features
3. Use Conventional Commits: `feat(runtime):`, `fix(web):`, etc.
4. Run `pnpm lint` and `pnpm test` before submitting
5. Follow React best practices from Vercel Engineering guidelines

## 📄 License

[Your License Here]

## 🔗 Resources

- [Claude Code Documentation](https://docs.anthropic.com)
- [Conductor.build](https://conductor.build)
- [Fastify](https://fastify.io)
- [Prisma](https://www.prisma.io)
- [React 19](https://react.dev)
