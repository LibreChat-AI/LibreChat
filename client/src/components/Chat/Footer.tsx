import React, { useEffect, memo } from 'react';
import TagManager from 'react-gtm-module';
import ReactMarkdown from 'react-markdown';
import { Constants, hasConfiguredFooter } from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import { policyUrls } from '~/utils/policies';
import { useLocalize } from '~/hooks';

type FooterProps = {
  className?: string;
  startupConfig?: FooterStartupConfig | null;
  /** A started conversation keeps only the footer the deployment wrote. The
   *  generic model disclaimer belongs to the welcome screen, where it is first
   *  read, and the policy links belong where they are agreed to: registration
   *  states the consent with both links, and the welcome screen the
   *  conversation starts from carries them under the composer. With no custom
   *  footer configured, this renders nothing at all. */
  configuredOnly?: boolean;
};

type FooterStartupConfig = Pick<Partial<TStartupConfig>, 'analyticsGtmId' | 'customFooter'> & {
  interface?: Pick<NonNullable<TStartupConfig['interface']>, 'privacyPolicy' | 'termsOfService'>;
};

/**
 * Whether the deployment configured footer content of its own, as the server
 * said when it served this document (`injectConfiguredFooterBootstrap`).
 *
 * Read once at module load: it is a property of the document, and an answer
 * that arrived a render later would be the guess this replaces. A shell that
 * carries no answer — the Vite dev server serves `client/index.html` itself —
 * reads as no footer, which is the default deployment.
 */
const shellHasConfiguredFooter =
  typeof window !== 'undefined' && window.__LIBRECHAT_CONFIG__?.hasConfiguredFooter === true;

/**
 * What a conversation has to render beneath its composer. The conversation
 * renders the footer only for configured content, and the composer above it
 * reserves the band that bar needs — the bar is absolutely positioned in a
 * zero-height wrapper, so a composer that did not reserve it would be painted
 * over. Both decisions read this one answer so they cannot disagree.
 *
 * Until `/api/config` answers, that answer is the shell's, which is the
 * deployment's own `CUSTOM_FOOTER`. A DB config override that sets or clears
 * the footer for the caller's tenant, role or user is resolved only by
 * `/api/config`, so on such a deployment the resolved answer (the one that
 * wins here) can differ from the shell's.
 */
export function useConfiguredFooter(): boolean {
  const { data: config, isSuccess } = useGetStartupConfig();

  return isSuccess ? hasConfiguredFooter(config) : shellHasConfiguredFooter;
}

function Footer({ className, startupConfig, configuredOnly = false }: FooterProps) {
  const shouldFetchConfig = startupConfig === undefined;
  const { data: fetchedConfig } = useGetStartupConfig({ enabled: shouldFetchConfig });
  const config = shouldFetchConfig ? fetchedConfig : startupConfig;
  const localize = useLocalize();

  /** The same reading the consent and the auth footer use: a blank url is not
   *  a published policy. */
  const { privacyPolicyUrl, termsOfServiceUrl } = policyUrls(configuredOnly ? undefined : config);

  const privacyPolicyRender = privacyPolicyUrl != null && (
    <a className="text-text-muted underline" href={privacyPolicyUrl} rel="noreferrer">
      {localize('com_ui_privacy_policy')}
    </a>
  );

  const termsOfServiceRender = termsOfServiceUrl != null && (
    <a className="text-text-muted underline" href={termsOfServiceUrl} rel="noreferrer">
      {localize('com_ui_terms_of_service')}
    </a>
  );

  const configuredFooter = typeof config?.customFooter === 'string' ? config.customFooter : null;
  /** The generic disclaimer is the part a conversation drops; the operator's own footer is not. */
  const genericFooter = configuredOnly
    ? ''
    : '[LibreChat ' +
      Constants.VERSION +
      '](https://librechat.ai) - ' +
      localize('com_ui_latest_footer');
  const mainContent = configuredFooter ?? genericFooter;
  const mainContentParts = mainContent === '' ? [] : mainContent.split('|');

  useEffect(() => {
    if (config?.analyticsGtmId != null && typeof window.google_tag_manager === 'undefined') {
      const tagManagerArgs = {
        gtmId: config.analyticsGtmId,
      };
      TagManager.initialize(tagManagerArgs);
    }
  }, [config?.analyticsGtmId]);

  const mainContentRender = mainContentParts.map((text, index) => (
    <React.Fragment key={`main-content-part-${index}`}>
      <ReactMarkdown
        components={{
          a: ({ node: _n, href, children, ...otherProps }) => {
            return (
              <a
                className="text-text-muted underline"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...otherProps}
              >
                {children}
              </a>
            );
          },

          p: ({ node: _n, ...props }) => <span {...props} />,
        }}
      >
        {text.trim()}
      </ReactMarkdown>
    </React.Fragment>
  ));

  const footerElements = [...mainContentRender, privacyPolicyRender, termsOfServiceRender].filter(
    Boolean,
  );

  /** A conversation with no configured footer has nothing to place, so it does
   *  not place an empty bar over the bottom of the thread. */
  if (footerElements.length === 0) {
    return null;
  }

  return (
    <div className="relative w-full">
      <div
        className={
          className ??
          /* The disclaimer is the least important text on the landing page and
             sat in `text-primary`, the same weight as the greeting above it.
             `text-muted` is the quietest text token that still clears AA for
             12px copy on `bg-presentation` — 5.11:1 on white, 7.93:1 on the dark
             canvas — and the contrast modes collapse every text token to pure
             black or white, so they stay at 21:1. The links keep the same colour
             rather than the brighter `text-secondary`: the underline carries the
             affordance, and a link that outshines its own sentence puts the
             emphasis back where this change takes it from. */
          'text-text-muted absolute right-0 bottom-0 left-0 hidden items-center justify-center gap-2 px-2 py-2 text-center text-xs sm:flex md:px-[3.75rem]'
        }
      >
        {footerElements.map((contentRender, index) => {
          const isLastElement = index === footerElements.length - 1;
          return (
            <React.Fragment key={`footer-element-${index}`}>
              {contentRender}
              {!isLastElement && (
                <div
                  key={`separator-${index}`}
                  className="border-border-medium h-2 border-r-[0.0625rem]"
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

const MemoizedFooter = memo(Footer);
MemoizedFooter.displayName = 'Footer';

export default MemoizedFooter;
