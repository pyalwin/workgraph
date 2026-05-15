export const metadata = {
  title: 'Terms of Service — WorkGraph',
  description: 'The terms under which you may use WorkGraph.',
};

const EFFECTIVE_DATE = 'May 10, 2026';
const CONTACT_EMAIL = 'arun.tgode@gmail.com';

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="legal-meta">Effective {EFFECTIVE_DATE}</p>

      <p>
        These terms govern your use of WorkGraph (&ldquo;the service&rdquo;). The
        software is open source under the MIT license; this document covers the
        managed cloud instance. Self-host instances are governed by the MIT
        license alone, with this document offered as informational reference.
      </p>

      <h2>1. Acceptance</h2>
      <p>
        By signing in to the cloud instance you agree to these terms and to the{' '}
        <a href="/privacy">Privacy Policy</a>. If you don&apos;t agree, do not
        sign in.
      </p>

      <h2>2. Account and eligibility</h2>
      <p>
        You must be at least 16 years old. You are responsible for keeping your
        account credentials secure and for all activity under your account. One
        person, one account.
      </p>

      <h2>3. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Reverse-engineer, decompile, or attempt to extract source code from the cloud service binaries</li>
        <li>Probe, scan, or test the vulnerability of the service except through a coordinated disclosure</li>
        <li>Use the service to violate any law or third-party rights</li>
        <li>Connect data sources you are not authorized to access</li>
        <li>Use the service to send unsolicited messages, scrape at abusive rates, or impersonate others</li>
        <li>Resell access or use the service to provide a substantially similar competing service</li>
      </ul>

      <h2>4. Your data</h2>
      <p>
        You retain all rights to the data you connect to the service. By using
        the service you grant the service a limited, non-exclusive license to
        process that data solely to provide the features you use (search,
        summarization, AI assistance, classification, etc.). The service does
        not claim ownership of your data and does not use it to train
        general-purpose AI models.
      </p>

      <h2>5. AI-generated output</h2>
      <p>
        The service uses third-party AI models (configurable; defaults include
        OpenRouter / Anthropic / Google / OpenAI) to generate summaries,
        classifications, draft replies, and chat responses. Generated output
        may be inaccurate, incomplete, or reflect biases in the underlying
        models. You are responsible for reviewing AI output before relying on
        it for decisions, communications, or compliance-sensitive work.
      </p>

      <h2>6. Service availability</h2>
      <p>
        The cloud service is provided as-is. We aim for reasonable uptime but
        do not currently offer an SLA. Maintenance, upgrades, or vendor outages
        may cause temporary unavailability. The service may be modified or
        discontinued at any time.
      </p>

      <h2>7. Pricing and billing</h2>
      <p>
        The cloud instance is in early access. Free trial terms or paid pricing,
        when introduced, will be communicated in-app and on the website before
        any charge. Payment processors and their terms apply at that time.
      </p>

      <h2>8. Termination</h2>
      <p>
        You can terminate at any time via Settings → Account → Delete account.
        On termination your data is deleted as described in the Privacy Policy.
        We may suspend or terminate accounts that violate these terms, with
        reasonable notice except in cases of urgent security or legal risk.
      </p>

      <h2>9. Disclaimers</h2>
      <p>
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo;
        WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
        LIMITED TO MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
        NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
        UNINTERRUPTED, SECURE, OR ERROR-FREE.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL THE SERVICE OR
        ITS MAINTAINERS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
        CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, DATA,
        USE, OR GOODWILL. AGGREGATE LIABILITY IS LIMITED TO THE GREATER OF
        ONE HUNDRED USD ($100) OR THE AMOUNT YOU PAID FOR THE SERVICE IN THE
        TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO LIABILITY.
      </p>

      <h2>11. Open source license</h2>
      <p>
        The underlying source code is available on GitHub under the MIT license.
        These terms govern only the cloud service, not the open-source software
        itself. You are free to fork, modify, and self-host under the MIT terms.
      </p>

      <h2>12. Changes to these terms</h2>
      <p>
        We may update these terms; material changes will be announced in-app
        before they take effect. Continued use after the effective date
        constitutes acceptance.
      </p>

      <h2>13. Governing law</h2>
      <p>
        These terms are governed by the laws of the state of California, USA,
        without regard to its conflict-of-laws principles. Disputes will be
        resolved in the courts located in San Francisco County, California.
      </p>

      <h2>14. Contact</h2>
      <p>
        Questions about these terms:{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>

      <p className="legal-disclaimer">
        This document is provided as a template for an open-source self-host project. It is not legal advice. Please review and adapt it with qualified counsel before relying on it for a production service.
      </p>
    </>
  );
}
