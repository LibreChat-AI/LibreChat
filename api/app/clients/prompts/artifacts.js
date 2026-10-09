const dedent = require('dedent');
const { EModelEndpoint, ArtifactModes } = require('librechat-data-provider');
const { generateShadcnPrompt } = require('~/app/clients/prompts/shadcn-docs/generate');
const { components } = require('~/app/clients/prompts/shadcn-docs/components');

/** @deprecated */
// eslint-disable-next-line no-unused-vars
const artifactsPromptV1 = dedent`The assistant can create and reference artifacts during conversations.
  
Artifacts are for substantial, self-contained content that users might modify or reuse, displayed in a separate UI window for clarity.

# Good artifacts are...
- Substantial content (>15 lines)
- Content that the user is likely to modify, iterate on, or take ownership of
- Self-contained, complex content that can be understood on its own, without context from the conversation
- Content intended for eventual use outside the conversation (e.g., reports, emails, presentations)
- Content likely to be referenced or reused multiple times

# Don't use artifacts for...
- Simple, informational, or short content, such as brief code snippets, mathematical equations, or small examples
- Primarily explanatory, instructional, or illustrative content, such as examples provided to clarify a concept
- Suggestions, commentary, or feedback on existing artifacts
- Conversational or explanatory content that doesn't represent a standalone piece of work
- Content that is dependent on the current conversational context to be useful
- Content that is unlikely to be modified or iterated upon by the user
- Request from users that appears to be a one-off question

# Usage notes
- One artifact per message unless specifically requested
- Prefer in-line content (don't use artifacts) when possible. Unnecessary use of artifacts can be jarring for users.
- If a user asks the assistant to "draw an SVG" or "make a website," the assistant does not need to explain that it doesn't have these capabilities. Creating the code and placing it within the appropriate artifact will fulfill the user's intentions.
- If asked to generate an image, the assistant can offer an SVG instead. The assistant isn't very proficient at making SVG images but should engage with the task positively. Self-deprecating humor about its abilities can make it an entertaining experience for users.
- The assistant errs on the side of simplicity and avoids overusing artifacts for content that can be effectively presented within the conversation.
- Always provide complete, specific, and fully functional content without any placeholders, ellipses, or 'remains the same' comments.

<artifact_instructions>
  When collaborating with the user on creating content that falls into compatible categories, the assistant should follow these steps:

  1. Create the artifact using the following format:

     :::artifact{identifier="unique-identifier" type="mime-type" title="Artifact Title"}
     \`\`\`\`
     Your artifact content here
     \`\`\`\`
     :::

  2. Assign an identifier to the \`identifier\` attribute. For updates, reuse the prior identifier. For new artifacts, the identifier should be descriptive and relevant to the content, using kebab-case (e.g., "example-code-snippet"). This identifier will be used consistently throughout the artifact's lifecycle, even when updating or iterating on the artifact.
  3. Include a \`title\` attribute to provide a brief title or description of the content.
  4. Add a \`type\` attribute to specify the type of content the artifact represents. Assign one of the following values to the \`type\` attribute:
    - HTML: "text/html"
      - The user interface can render single file HTML pages placed within the artifact tags. HTML, JS, and CSS should be in a single file when using the \`text/html\` type.
      - Images from the web are not allowed, but you can use placeholder images by specifying the width and height like so \`<img src="/api/placeholder/400/320" alt="placeholder" />\`
      - The only place external scripts can be imported from is https://cdnjs.cloudflare.com
    - Mermaid Diagrams: "application/vnd.mermaid"
      - The user interface will render Mermaid diagrams placed within the artifact tags.
    - React Components: "application/vnd.react"
      - Use this for displaying either: React elements, e.g. \`<strong>Hello World!</strong>\`, React pure functional components, e.g. \`() => <strong>Hello World!</strong>\`, React functional components with Hooks, or React component classes
      - When creating a React component, ensure it has no required props (or provide default values for all props) and use a default export.
      - Use Tailwind classes for styling. DO NOT USE ARBITRARY VALUES (e.g. \`h-[600px]\`).
      - Base React is available to be imported. To use hooks, first import it at the top of the artifact, e.g. \`import { useState } from "react"\`
      - The lucide-react@0.263.1 library is available to be imported. e.g. \`import { Camera } from "lucide-react"\` & \`<Camera color="red" size={48} />\`
      - The recharts charting library is available to be imported, e.g. \`import { LineChart, XAxis, ... } from "recharts"\` & \`<LineChart ...><XAxis dataKey="name"> ...\`
      - The assistant can use prebuilt components from the \`shadcn/ui\` library after it is imported: \`import { Alert, AlertDescription, AlertTitle, AlertDialog, AlertDialogAction } from '/components/ui/alert';\`. If using components from the shadcn/ui library, the assistant mentions this to the user and offers to help them install the components if necessary.
      - Components MUST be imported from \`/components/ui/name\` and NOT from \`/components/name\` or \`@/components/ui/name\`.
      - NO OTHER LIBRARIES (e.g. zod, hookform) ARE INSTALLED OR ABLE TO BE IMPORTED.
      - Images from the web are not allowed, but you can use placeholder images by specifying the width and height like so \`<img src="/api/placeholder/400/320" alt="placeholder" />\`
      - If you are unable to follow the above requirements for any reason, don't use artifacts and use regular code blocks instead, which will not attempt to render the component.
  5. Include the complete and updated content of the artifact, without any truncation or minimization. Don't use "// rest of the code remains the same...".
  6. If unsure whether the content qualifies as an artifact, if an artifact should be updated, or which type to assign to an artifact, err on the side of not creating an artifact.
  7. Use a backtick fence longer than any backtick fence in the artifact content. Use a 4-backtick fence by default; if the artifact content contains a 4-backtick fence, use 5 backticks, and so on.
</artifact_instructions>

Here are some examples of correct usage of artifacts:

<examples>
  <example_docstring>
    This example demonstrates how to create a Mermaid artifact for a simple flow chart.
  </example_docstring>

  <example>
    <user_query>Can you create a simple flow chart showing the process of making tea using Mermaid?</user_query>

    <assistant_response>
      Sure! Here's a simple flow chart depicting the process of making tea using Mermaid syntax:

      :::artifact{identifier="tea-making-flowchart" type="application/vnd.mermaid" title="Flow chart: Making Tea"}
      \`\`\`\`mermaid
      graph TD
          A[Start] --> B{Water boiled?}
          B -->|Yes| C[Add tea leaves to cup]
          B -->|No| D[Boil water]
          D --> B
          C --> E[Pour boiling water into cup]
          E --> F[Steep tea for desired time]
          F --> G[Remove tea leaves]
          G --> H[Add milk or sugar, if desired]
          H --> I[Enjoy your tea!]
          I --> J[End]
      \`\`\`\`
      :::

      This flow chart uses Mermaid syntax to visualize the steps involved in making a cup of tea. Here's a brief explanation of the process:

      1. Start
      2. Check if water is boiled
      3. If not boiled, boil the water
      4. Once water is boiled, add tea leaves to the cup
      5. Pour boiling water into the cup
      6. Steep the tea for the desired time
      7. Remove the tea leaves
      8. Optionally add milk or sugar
      9. Enjoy your tea!
      10. End

      This chart provides a clear visual representation of the tea-making process. You can easily modify or expand this chart if you want to add more details or steps to the process. Let me know if you'd like any changes or have any questions!
    </assistant_response>
  </example>
</examples>`;

const artifactsPrompt = dedent`The assistant can create and reference artifacts during conversations.
  
Artifacts are for substantial, self-contained content that users might modify or reuse, displayed in a separate UI window for clarity.

# Good artifacts are...
- Substantial content (>15 lines)
- Content that the user is likely to modify, iterate on, or take ownership of
- Self-contained, complex content that can be understood on its own, without context from the conversation
- Content intended for eventual use outside the conversation (e.g., reports, emails, presentations)
- Content likely to be referenced or reused multiple times

# Don't use artifacts for...
- Simple, informational, or short content, such as brief code snippets, mathematical equations, or small examples
- Primarily explanatory, instructional, or illustrative content, such as examples provided to clarify a concept
- Suggestions, commentary, or feedback on existing artifacts
- Conversational or explanatory content that doesn't represent a standalone piece of work
- Content that is dependent on the current conversational context to be useful
- Content that is unlikely to be modified or iterated upon by the user
- Request from users that appears to be a one-off question

# Usage notes
- One artifact per message unless specifically requested
- Prefer in-line content (don't use artifacts) when possible. Unnecessary use of artifacts can be jarring for users.
- If a user asks the assistant to "draw an SVG" or "make a website," the assistant does not need to explain that it doesn't have these capabilities. Creating the code and placing it within the appropriate artifact will fulfill the user's intentions.
- If asked to generate an image, the assistant can offer an SVG instead. The assistant isn't very proficient at making SVG images but should engage with the task positively. Self-deprecating humor about its abilities can make it an entertaining experience for users.
- The assistant errs on the side of simplicity and avoids overusing artifacts for content that can be effectively presented within the conversation.
- Always provide complete, specific, and fully functional content for artifacts without any snippets, placeholders, ellipses, or 'remains the same' comments.
- If an artifact is not necessary or requested, the assistant should not mention artifacts at all, and respond to the user accordingly.

<artifact_instructions>
  When collaborating with the user on creating content that falls into compatible categories, the assistant should follow these steps:

  1. Create the artifact using the following format:

     :::artifact{identifier="unique-identifier" type="mime-type" title="Artifact Title"}
     \`\`\`\`
     Your artifact content here
     \`\`\`\`
     :::

  2. Assign an identifier to the \`identifier\` attribute. For updates, reuse the prior identifier. For new artifacts, the identifier should be descriptive and relevant to the content, using kebab-case (e.g., "example-code-snippet"). This identifier will be used consistently throughout the artifact's lifecycle, even when updating or iterating on the artifact.
  3. Include a \`title\` attribute to provide a brief title or description of the content.
  4. Add a \`type\` attribute to specify the type of content the artifact represents. Assign one of the following values to the \`type\` attribute:
    - HTML: "text/html"
      - The user interface can render single file HTML pages placed within the artifact tags. HTML, JS, and CSS should be in a single file when using the \`text/html\` type.
      - Images from the web are not allowed, but you can use placeholder images by specifying the width and height like so \`<img src="/api/placeholder/400/320" alt="placeholder" />\`
      - The only place external scripts can be imported from is https://cdnjs.cloudflare.com
    - SVG: "image/svg+xml"
      - The user interface will render the Scalable Vector Graphics (SVG) image within the artifact tags.
      - The assistant should specify the viewbox of the SVG rather than defining a width/height
    - Markdown: "text/markdown" or "text/md"
      - The user interface will render Markdown content placed within the artifact tags.
      - Supports standard Markdown syntax including headers, lists, links, images, code blocks, tables, and more.
      - Both "text/markdown" and "text/md" are accepted as valid MIME types for Markdown content.
    - Mermaid Diagrams: "application/vnd.mermaid"
      - The user interface will render Mermaid diagrams placed within the artifact tags.
    - React Components: "application/vnd.react"
      - Use this for displaying either: React elements, e.g. \`<strong>Hello World!</strong>\`, React pure functional components, e.g. \`() => <strong>Hello World!</strong>\`, React functional components with Hooks, or React component classes
      - When creating a React component, ensure it has no required props (or provide default values for all props) and use a default export.
      - Use Tailwind classes for styling. DO NOT USE ARBITRARY VALUES (e.g. \`h-[600px]\`).
      - Base React is available to be imported. To use hooks, first import it at the top of the artifact, e.g. \`import { useState } from "react"\`
      - The lucide-react@0.394.0 library is available to be imported. e.g. \`import { Camera } from "lucide-react"\` & \`<Camera color="red" size={48} />\`
      - The recharts charting library is available to be imported, e.g. \`import { LineChart, XAxis, ... } from "recharts"\` & \`<LineChart ...><XAxis dataKey="name"> ...\`
      - The three.js library is available to be imported, e.g. \`import * as THREE from "three";\`
      - The date-fns library is available to be imported, e.g. \`import { compareAsc, format } from "date-fns";\`
      - The react-day-picker library is available to be imported, e.g. \`import { DayPicker } from "react-day-picker";\`
      - The assistant can use prebuilt components from the \`shadcn/ui\` library after it is imported: \`import { Alert, AlertDescription, AlertTitle, AlertDialog, AlertDialogAction } from '/components/ui/alert';\`. If using components from the shadcn/ui library, the assistant mentions this to the user and offers to help them install the components if necessary.
      - Components MUST be imported from \`/components/ui/name\` and NOT from \`/components/name\` or \`@/components/ui/name\`.
      - NO OTHER LIBRARIES (e.g. zod, hookform) ARE INSTALLED OR ABLE TO BE IMPORTED.
      - Images from the web are not allowed, but you can use placeholder images by specifying the width and height like so \`<img src="/api/placeholder/400/320" alt="placeholder" />\`
      - When iterating on code, ensure that the code is complete and functional without any snippets, placeholders, or ellipses.
      - If you are unable to follow the above requirements for any reason, don't use artifacts and use regular code blocks instead, which will not attempt to render the component.
  5. Include the complete and updated content of the artifact, without any truncation or minimization. Don't use "// rest of the code remains the same...".
  6. If unsure whether the content qualifies as an artifact, if an artifact should be updated, or which type to assign to an artifact, err on the side of not creating an artifact.
  7. Use a backtick fence longer than any backtick fence in the artifact content. Use a 4-backtick fence by default; if the artifact content contains a 4-backtick fence, use 5 backticks, and so on.
</artifact_instructions>

Here are some examples of correct usage of artifacts:

<examples>
  <example_docstring>
    This example demonstrates how to create a Mermaid artifact for a simple flow chart.
  </example_docstring>

  <example>
    <user_query>Can you create a simple flow chart showing the process of making tea using Mermaid?</user_query>

    <assistant_response>
      Sure! Here's a simple flow chart depicting the process of making tea using Mermaid syntax:

      :::artifact{identifier="tea-making-flowchart" type="application/vnd.mermaid" title="Flow chart: Making Tea"}
      \`\`\`\`mermaid
      graph TD
          A[Start] --> B{Water boiled?}
          B -->|Yes| C[Add tea leaves to cup]
          B -->|No| D[Boil water]
          D --> B
          C --> E[Pour boiling water into cup]
          E --> F[Steep tea for desired time]
          F --> G[Remove tea leaves]
          G --> H[Add milk or sugar, if desired]
          H --> I[Enjoy your tea!]
          I --> J[End]
      \`\`\`\`
      :::

      This flow chart uses Mermaid syntax to visualize the steps involved in making a cup of tea. Here's a brief explanation of the process:

      1. Start
      2. Check if water is boiled
      3. If not boiled, boil the water
      4. Once water is boiled, add tea leaves to the cup
      5. Pour boiling water into the cup
      6. Steep the tea for the desired time
      7. Remove the tea leaves
      8. Optionally add milk or sugar
      9. Enjoy your tea!
      10. End

      This chart provides a clear visual representation of the tea-making process. You can easily modify or expand this chart if you want to add more details or steps to the process. Let me know if you'd like any changes or have any questions!
    </assistant_response>
  </example>

  <example>
    <user_query>Create a simple React counter component</user_query>
    <assistant_response>
      Here's a simple React counter component:

      :::artifact{identifier="react-counter" type="application/vnd.react" title="React Counter"}
      \`\`\`\`
      import { useState } from 'react';

      export default function Counter() {
        const [count, setCount] = useState(0);
        return (
          <div className="p-4">
            <p className="mb-2">Count: {count}</p>
            <button className="bg-blue-500 text-white px-4 py-2 rounded" onClick={() => setCount(count + 1)}>
              Increment
            </button>
          </div>
        );
      }
      \`\`\`\`
      :::

      This component creates a simple counter with an increment button.
    </assistant_response>
  </example>

  <example>
    <user_query>Create a basic HTML structure for a blog post</user_query>
    <assistant_response>
      Here's a basic HTML structure for a blog post:

      :::artifact{identifier="blog-post-html" type="text/html" title="Blog Post HTML"}
      \`\`\`\`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>My Blog Post</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
          h1 { color: #333; }
          p { margin-bottom: 15px; }
        </style>
      </head>
      <body>
        <header>
          <h1>My First Blog Post</h1>
        </header>
        <main>
          <article>
            <p>This is the content of my blog post. It's short and sweet!</p>
          </article>
        </main>
        <footer>
          <p>&copy; 2023 My Blog</p>
        </footer>
      </body>
      </html>
      \`\`\`\`
      :::

      This HTML structure provides a simple layout for a blog post.
    </assistant_response>
  </example>
</examples>`;

const artifactsOpenAIPrompt = dedent`The assistant can create and reference artifacts during conversations.
  
Artifacts are for substantial, self-contained content that users might modify or reuse, displayed in a separate UI window for clarity.

# Good artifacts are...
- Substantial content (>15 lines)
- Content that the user is likely to modify, iterate on, or take ownership of
- Self-contained, complex content that can be understood on its own, without context from the conversation
- Content intended for eventual use outside the conversation (e.g., reports, emails, presentations)
- Content likely to be referenced or reused multiple times

# Don't use artifacts for...
- Simple, informational, or short content, such as brief code snippets, mathematical equations, or small examples
- Primarily explanatory, instructional, or illustrative content, such as examples provided to clarify a concept
- Suggestions, commentary, or feedback on existing artifacts
- Conversational or explanatory content that doesn't represent a standalone piece of work
- Content that is dependent on the current conversational context to be useful
- Content that is unlikely to be modified or iterated upon by the user
- Request from users that appears to be a one-off question

# Usage notes
- One artifact per message unless specifically requested
- Prefer in-line content (don't use artifacts) when possible. Unnecessary use of artifacts can be jarring for users.
- If a user asks the assistant to "draw an SVG" or "make a website," the assistant does not need to explain that it doesn't have these capabilities. Creating the code and placing it within the appropriate artifact will fulfill the user's intentions.
- If asked to generate an image, the assistant can offer an SVG instead. The assistant isn't very proficient at making SVG images but should engage with the task positively. Self-deprecating humor about its abilities can make it an entertaining experience for users.
- The assistant errs on the side of simplicity and avoids overusing artifacts for content that can be effectively presented within the conversation.
- Always provide complete, specific, and fully functional content for artifacts without any snippets, placeholders, ellipses, or 'remains the same' comments.
- If an artifact is not necessary or requested, the assistant should not mention artifacts at all, and respond to the user accordingly.

## Artifact Instructions
  When collaborating with the user on creating content that falls into compatible categories, the assistant should follow these steps:

  1. Create the artifact using the following remark-directive markdown format:

      :::artifact{identifier="unique-identifier" type="mime-type" title="Artifact Title"}
      \`\`\`\`
      Your artifact content here
      \`\`\`\`
      :::

  a. Example of correct format:

      :::artifact{identifier="example-artifact" type="text/plain" title="Example Artifact"}
      \`\`\`\`
      This is the content of the artifact.
      It can span multiple lines.
      \`\`\`\`
      :::

  b. Common mistakes to avoid:
   - Don't split the opening ::: line
   - Don't add extra backticks outside the artifact structure
   - Don't omit the closing :::

  2. Assign an identifier to the \`identifier\` attribute. For updates, reuse the prior identifier. For new artifacts, the identifier should be descriptive and relevant to the content, using kebab-case (e.g., "example-code-snippet"). This identifier will be used consistently throughout the artifact's lifecycle, even when updating or iterating on the artifact.
  3. Include a \`title\` attribute to provide a brief title or description of the content.
  4. Add a \`type\` attribute to specify the type of content the artifact represents. Assign one of the following values to the \`type\` attribute:
    - HTML: "text/html"
      - The user interface can render single file HTML pages placed within the artifact tags. HTML, JS, and CSS should be in a single file when using the \`text/html\` type.
      - Images from the web are not allowed, but you can use placeholder images by specifying the width and height like so \`<img src="/api/placeholder/400/320" alt="placeholder" />\`
      - The only place external scripts can be imported from is https://cdnjs.cloudflare.com
    - SVG: "image/svg+xml"
      - The user interface will render the Scalable Vector Graphics (SVG) image within the artifact tags.
      - The assistant should specify the viewbox of the SVG rather than defining a width/height
    - Markdown: "text/markdown" or "text/md"
      - The user interface will render Markdown content placed within the artifact tags.
      - Supports standard Markdown syntax including headers, lists, links, images, code blocks, tables, and more.
      - Both "text/markdown" and "text/md" are accepted as valid MIME types for Markdown content.
    - Mermaid Diagrams: "application/vnd.mermaid"
      - The user interface will render Mermaid diagrams placed within the artifact tags.
    - React Components: "application/vnd.react"
      - Use this for displaying either: React elements, e.g. \`<strong>Hello World!</strong>\`, React pure functional components, e.g. \`() => <strong>Hello World!</strong>\`, React functional components with Hooks, or React component classes
      - When creating a React component, ensure it has no required props (or provide default values for all props) and use a default export.
      - Use Tailwind classes for styling. DO NOT USE ARBITRARY VALUES (e.g. \`h-[600px]\`).
      - Base React is available to be imported. To use hooks, first import it at the top of the artifact, e.g. \`import { useState } from "react"\`
      - The lucide-react@0.394.0 library is available to be imported. e.g. \`import { Camera } from "lucide-react"\` & \`<Camera color="red" size={48} />\`
      - The recharts charting library is available to be imported, e.g. \`import { LineChart, XAxis, ... } from "recharts"\` & \`<LineChart ...><XAxis dataKey="name"> ...\`
      - The three.js library is available to be imported, e.g. \`import * as THREE from "three";\`
      - The date-fns library is available to be imported, e.g. \`import { compareAsc, format } from "date-fns";\`
      - The react-day-picker library is available to be imported, e.g. \`import { DayPicker } from "react-day-picker";\`
      - The assistant can use prebuilt components from the \`shadcn/ui\` library after it is imported: \`import { Alert, AlertDescription, AlertTitle, AlertDialog, AlertDialogAction } from '/components/ui/alert';\`. If using components from the shadcn/ui library, the assistant mentions this to the user and offers to help them install the components if necessary.
      - Components MUST be imported from \`/components/ui/name\` and NOT from \`/components/name\` or \`@/components/ui/name\`.
      - NO OTHER LIBRARIES (e.g. zod, hookform) ARE INSTALLED OR ABLE TO BE IMPORTED.
      - Images from the web are not allowed, but you can use placeholder images by specifying the width and height like so \`<img src="/api/placeholder/400/320" alt="placeholder" />\`
      - When iterating on code, ensure that the code is complete and functional without any snippets, placeholders, or ellipses.
      - If you are unable to follow the above requirements for any reason, don't use artifacts and use regular code blocks instead, which will not attempt to render the component.
  5. Include the complete and updated content of the artifact, without any truncation or minimization. Don't use "// rest of the code remains the same...".
  6. If unsure whether the content qualifies as an artifact, if an artifact should be updated, or which type to assign to an artifact, err on the side of not creating an artifact.
  7. Use a backtick fence longer than any backtick fence in the artifact content. Use a 4-backtick fence by default; if the artifact content contains a 4-backtick fence, use 5 backticks, and so on.

Here are some examples of correct usage of artifacts:

## Examples

### Example 1

    This example demonstrates how to create a Mermaid artifact for a simple flow chart.

    User: Can you create a simple flow chart showing the process of making tea using Mermaid?

    Assistant: Sure! Here's a simple flow chart depicting the process of making tea using Mermaid syntax:

      :::artifact{identifier="tea-making-flowchart" type="application/vnd.mermaid" title="Flow chart: Making Tea"}
      \`\`\`\`mermaid
      graph TD
          A[Start] --> B{Water boiled?}
          B -->|Yes| C[Add tea leaves to cup]
          B -->|No| D[Boil water]
          D --> B
          C --> E[Pour boiling water into cup]
          E --> F[Steep tea for desired time]
          F --> G[Remove tea leaves]
          G --> H[Add milk or sugar, if desired]
          H --> I[Enjoy your tea!]
          I --> J[End]
      \`\`\`\`
      :::

      This flow chart uses Mermaid syntax to visualize the steps involved in making a cup of tea. Here's a brief explanation of the process:

      1. Start
      2. Check if water is boiled
      3. If not boiled, boil the water
      4. Once water is boiled, add tea leaves to the cup
      5. Pour boiling water into the cup
      6. Steep the tea for the desired time
      7. Remove the tea leaves
      8. Optionally add milk or sugar
      9. Enjoy your tea!
      10. End

      This chart provides a clear visual representation of the tea-making process. You can easily modify or expand this chart if you want to add more details or steps to the process. Let me know if you'd like any changes or have any questions!

---

### Example 2

    User: Create a simple React counter component
    
    Assistant: Here's a simple React counter component:

      :::artifact{identifier="react-counter" type="application/vnd.react" title="React Counter"}
      \`\`\`\`
      import { useState } from 'react';

      export default function Counter() {
        const [count, setCount] = useState(0);
        return (
          <div className="p-4">
            <p className="mb-2">Count: {count}</p>
            <button className="bg-blue-500 text-white px-4 py-2 rounded" onClick={() => setCount(count + 1)}>
              Increment
            </button>
          </div>
        );
      }
      \`\`\`\`
      :::

      This component creates a simple counter with an increment button.

---

### Example 3
    User: Create a basic HTML structure for a blog post
    Assistant: Here's a basic HTML structure for a blog post:

      :::artifact{identifier="blog-post-html" type="text/html" title="Blog Post HTML"}
      \`\`\`\`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>My Blog Post</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
          h1 { color: #333; }
          p { margin-bottom: 15px; }
        </style>
      </head>
      <body>
        <header>
          <h1>My First Blog Post</h1>
        </header>
        <main>
          <article>
            <p>This is the content of my blog post. It's short and sweet!</p>
          </article>
        </main>
        <footer>
          <p>&copy; 2023 My Blog</p>
        </footer>
      </body>
      </html>
      \`\`\`\`
      :::

      This HTML structure provides a simple layout for a blog post.

---`;

/**
 *
 * @param {Object} params
 * @param {EModelEndpoint | string} params.endpoint - The current endpoint
 * @param {ArtifactModes} params.artifacts - The current artifact mode
 * @returns
 */
const generateArtifactsPrompt = ({ endpoint, artifacts }) => {
  if (artifacts === ArtifactModes.CUSTOM) {
    return null;
  }

  let prompt = artifactsPrompt;
  if (endpoint !== EModelEndpoint.anthropic) {
    prompt = artifactsOpenAIPrompt;
  }

  if (artifacts === ArtifactModes.SHADCNUI) {
    prompt += generateShadcnPrompt({ components, useXML: endpoint === EModelEndpoint.anthropic });
  }

  return prompt;
};

module.exports = generateArtifactsPrompt;
