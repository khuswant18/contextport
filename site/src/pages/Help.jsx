const FAQ = [
  ['Which assistants are supported?', 'ChatGPT (chatgpt.com), Claude (claude.ai), Google Gemini (gemini.google.com) and Perplexity. You can transfer from any of them to any other.'],
  ['What is the difference between Smart brief and Full transcript?', 'Smart brief is a structured handover — goal, requirements, decisions, what was tried, where things stand, next steps and the exact code. It is shorter, so the next assistant focuses on what matters. Full transcript sends every message as-is, which is useful for short chats or when you want nothing left out.'],
  ['Does ContextPort send messages for me?', 'Never. It only fills in the message box of the new chat. You review it, edit if you like, and press send yourself.'],
  ['How many free transfers do I get?', 'ContextPort AI includes a generous number of free transfers per day, shown in the toolbar popup. They reset at midnight UTC. For unlimited use, add your own API key in Settings.'],
  ['Which API keys can I use?', 'OpenAI, Anthropic (Claude), Google Gemini, Groq, OpenRouter, DeepSeek, Mistral, xAI and Together AI. Type any model your key can use — ContextPort checks it with one tiny test request. Your key is stored only in your browser and sent only to that provider.'],
  ['Is code preserved exactly?', 'Yes. Code blocks are lifted out of the conversation before summarising and put back character-for-character, so nothing is paraphrased or cut.'],
  ['Where is my history stored?', 'In your browser only, in the ContextPort Library (open it from the toolbar popup). You can search it, resend any transfer to another assistant, export it, or delete it.'],
  ['Can I bring a saved brief into a new chat?', 'Yes. On a new, empty chat, click Transfer (or choose “Insert a saved brief” from its menu) and pick any brief you sent or saved before. It is added to the message box — nothing is sent until you press send.'],
  ['What are checkpoints and projects?', 'Save a brief without sending it (the bookmark button), then resume it later in any AI from the Library. Group related briefs into a project and use “Continue project” to send the latest brief with a timeline of what came before.'],
  ['How do share links work?', 'The share button creates a link to a read-only copy of your brief. It’s encrypted in your browser and the key is part of the link, so only people you send it to can read it. Links expire after 7 days and can be revoked in the Library.'],
  ['How do snippets and the About me card work?', 'In Settings, write a short About me card and save your favourite prompts. Type // in any ChatGPT, Claude or Gemini message box (or press Alt+Shift+S) to insert a snippet, and add your About me card to any transfer.'],
  ['How do invites work?', 'Settings → Invite friends shows your code. When a friend enters it within 7 days of installing, you both get extra free ContextPort AI transfers every day.'],
  ['Very long chats?', 'ContextPort keeps the opening request and the most recent messages in full, and shortens older middle turns if needed. With your own API key, much longer conversations fit before anything is shortened.'],
];


const TROUBLE = [
  ['The Transfer button doesn’t appear', 'It shows on every ChatGPT, Claude, Gemini and Perplexity chat, including new ones. After installing or updating the extension, reload the chat page once. You can also use the toolbar icon or Alt+Shift+T. If you turned it off, switch “Floating Transfer button” back on in Settings.'],
  ['The context wasn’t added to the new chat', 'If the destination asked you to sign in, sign in and the context is added automatically within 10 minutes. Otherwise, click “Copy context” in the message at the bottom of the page and paste it with Ctrl/Cmd + V.'],
  ['“Wait for the assistant to finish”', 'ContextPort waits until the reply has finished streaming, so the brief includes the full answer.'],
  ['It used an offline summary', 'This happens when ContextPort AI is busy or its server isn’t responding, you have used today’s free transfers, or your own key was rejected. The panel tells you which. Click “Try again”, or add your own API key in Settings so transfers never depend on our server.'],
];

export default function Help() {
  return (
    <>
      <section className="page-head">
        <div className="orb" />
        <div className="wrap">
          <p className="eyebrow">Help</p>
          <h1 className="display d-xl" style={{ marginTop: 12 }}>Help & FAQ</h1>
          <p className="lead">Everything you need to move conversations smoothly.</p>
        </div>
      </section>
      <section className="wrap" style={{ paddingBottom: 48 }}>
        <div className="faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="wrap" id="troubleshooting" style={{ paddingBottom: 96 }}>
        <h2 className="display d-lg" style={{ margin: '32px 0 16px' }}>Troubleshooting</h2>
        <div className="faq">
          {TROUBLE.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
