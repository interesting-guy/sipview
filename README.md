# SipView: The AI-Powered Sui Improvement Proposal Tracker

SipView is a modern, open-source web application designed to help users browse, search, and understand Sui Improvement Proposals (SIPs). It leverages Generative AI to make complex blockchain governance proposals accessible to everyone, from core developers to curious community members.

![SipView Screenshot](https://github.com/user-attachments/assets/a1c7da48-21c1-4336-b479-5438874ce7be)

## ✨ Key Features

- **Comprehensive SIP Dashboard**: View all SIPs from the official repositories, including active pull requests, in a clean, sortable, and searchable table.
- **AI-Powered Summaries**: Every proposal is enhanced with an AI-generated summary that breaks down its purpose into three key points:
  - **What it is**: A one-sentence explanation.
  - **What it changes**: A one-sentence summary of the impact.
  - **Why it matters**: A one-sentence highlight of the benefit.
- **"Explain Like I'm 5" (ELI5)**: A "Simplify" button on each SIP detail page provides a super-simple, two-paragraph explanation, making even the most technical proposals easy to grasp.
- **Discussion Summaries**: Understand the community sentiment at a glance with AI-generated summaries of the GitHub discussion comments for each proposal.
- **Categorized Topics View**: Explore SIPs grouped by relevant topics like Security, DeFi, Governance, Developer Tooling, and more.
- **Rich UI/UX**:
  - Light and Dark mode theme toggle.
  - Responsive design for desktop and mobile.
  - Subtle micro-interactions for a polished user experience.
  - Onboarding tooltips to guide new users.
- **Direct GitHub Integration**: Fetches the latest comments from GitHub PRs and provides direct links to view the source proposals and discussions.

## 🛠️ Tech Stack

SipView is built with a modern, production-ready tech stack:

- **Framework**: [Next.js](https://nextjs.org/) (App Router)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Generative AI**: [Google AI](https://ai.google/) via [Genkit](https://firebase.google.com/docs/genkit)
- **UI Components**: [ShadCN UI](https://ui.shadcn.com/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Icons**: [Lucide React](https://lucide.dev/)
- **Data Source**: [GitHub API](https://docs.github.com/en/rest)

## 🚀 Getting Started

To run SipView locally, follow these steps:

### Prerequisites

- Node.js (v18 or later)
- npm, pnpm, or yarn

### 1. Clone the Repository

```bash
git clone <repository-url>
cd sip-view-app
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Environment Variables

This project requires a Google AI API key for its generative features and recommends a GitHub token for a higher API rate limit.

1.  Copy the `.env.example` file to a new file named `.env`:

    ```bash
    cp .env.example .env
    ```

2.  Add your API keys to the `.env` file:

    -   **`GOOGLE_API_KEY`**: Get your key from [Google AI Studio](https://aistudio.google.com/app/apikey).
    -   **`GITHUB_TOKEN`** (Optional): Generate a personal access token from your [GitHub settings](https://github.com/settings/tokens) to avoid rate-limiting issues when fetching data.

### 4. Run the Development Servers

You need to run two processes in parallel in separate terminal windows:

-   **Terminal 1: Run the Next.js Frontend**

    ```bash
    npm run dev
    ```
    This will start the web application, typically on `http://localhost:9002`.

-   **Terminal 2: Run the Genkit AI Flows**

    ```bash
    npm run genkit:watch
    ```
    This starts the Genkit development server, which handles all the AI-powered summarization and explanation tasks.

Once both servers are running, you can open your browser to view the app.

---
Created by Tushar Khatwani - [@tusharlog1](https://twitter.com/tusharlog1)
