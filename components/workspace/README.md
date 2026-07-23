# API Builder Components

This directory contains the new BaaS-style UI components for the API Builder (formerly Workspace).

**Design Pattern:** IDE-style endpoint list (like BuildUO) with AI prompt-driven modifications.

## Components (3 Total)

### 1. PromptCommandBar
**Location:** `PromptCommandBar.tsx`

The sticky command bar at the top of API Builder page that allows users to describe backend changes in natural language.

**Features:**
- Sticky positioning (always visible)
- Cmd/Ctrl + Enter to submit
- Loading states
- AI-native prompt interface

**Usage:**
```tsx
<PromptCommandBar 
  onPreview={(prompt) => handlePromptPreview(prompt)} 
  isLoading={isGenerating} 
/>
```

---

### 2. BackendOverviewCards
**Location:** `BackendOverviewCards.tsx`

Displays backend statistics in a BaaS-style card grid.

**Shows:**
- Number of API endpoints
- Number of database models
- Auth status (enabled/disabled)
- Storage status (enabled/disabled)
- Environment (dev/prod)

**Usage:**
```tsx
<BackendOverviewCards 
  stats={{
    endpoints: 8,
    models: 4,
    authEnabled: true,
    storageEnabled: false,
    environment: 'dev'
  }} 
/>
```

---

### 3. FeatureList
**Location:** `FeatureList.tsx`

IDE-style accordion list showing features and their endpoints (BuildUO pattern).

**Features:**
- Collapsible feature groups
- Endpoints listed vertically with HTTP method badges
- Click endpoint to view/edit code
- Status indicators (active, draft, disabled, suggested)
- Space-efficient tree layout
- Auto-expands active features

**Usage:**
```tsx
<FeatureList
  features={[
    {
      id: 'auth',
      icon: <Lock />,
      title: 'User Authentication',
      status: 'active',
      endpoints: [
        { method: 'POST', path: '/auth/register' },
        { method: 'POST', path: '/auth/login' }
      ]
    }
  ]}
  onEndpointClick={(featureId, endpoint) => handleViewCode(featureId, endpoint)}
  onViewCode={(featureId) => handleViewCode(featureId)}
/>
```

**Why This Pattern:**
- ✅ **Space-efficient** - Vertical list uses less space than cards
- ✅ **Professional** - Matches IDE/API tool conventions
- ✅ **Scannable** - Easy to see all endpoints at once
- ✅ **Familiar** - Developers recognize this pattern (Postman, BuildUO, Swagger)

---

## Architecture

### Visual-First, Code-Second
- Default view shows feature cards (no code)
- Code is only shown in "Advanced Mode"
- Users can toggle between Simple and Advanced views

### Prompt-Driven, Not Chat-Driven
- Single command bar at top (not a chat interface)
- One prompt = one backend mutation
- Preview changes before applying

### BaaS Consistency
- Matches visual style of Database, Auth, Storage sections
- No IDE-like file tree in default view
- Button-based interactions

---

## Design Principles

1. **No File Tree by Default** - Features are organized by capability, not file structure
2. **Code is Inspectable** - Advanced users can view generated code
3. **Progressive Disclosure** - Simple → Advanced mode toggle
4. **Single Source of Truth** - Backend state drives both GUI and code
5. **Transparent** - Always show what will change before applying

---

## Migration from Old Workspace

**Old Workspace:**
- IDE-style file explorer
- Code editor front and center
- Manual coding required

**New API Builder:**
- Feature cards showing capabilities
- Visual configuration
- Code optional (Advanced Mode only)
- AI prompt-driven changes

---

## Future Enhancements

1. **Template Library** - More pre-built feature templates
2. **Visual Configuration Forms** - GUI forms for configuring features
3. **Real-time Collaboration** - Multiple users building backend
4. **Feature Dependencies** - Auto-detect required features (e.g., Auth for user-owned content)
5. **Cost Estimation** - Show estimated usage/cost before enabling features
