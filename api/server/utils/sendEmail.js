const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const nodemailer = require('nodemailer');
const handlebars = require('handlebars');
const { logger } = require('@librechat/data-schemas');
const { logAxiosError, isEnabled, readFileAsString } = require('@librechat/api');

/**
 * Sends an email using Mailgun API.
 *
 * @async
 * @function sendEmailViaMailgun
 * @param {Object} params - The parameters for sending the email.
 * @param {string} params.to - The recipient's email address.
 * @param {string} params.from - The sender's email address.
 * @param {string} params.subject - The subject of the email.
 * @param {string} params.html - The HTML content of the email.
 * @returns {Promise<Object>} - A promise that resolves to the response from Mailgun API.
 */
const sendEmailViaMailgun = async ({ to, from, subject, html }) => {
  const mailgunApiKey = process.env.MAILGUN_API_KEY;
  const mailgunDomain = process.env.MAILGUN_DOMAIN;
  const mailgunHost = process.env.MAILGUN_HOST || 'https://api.mailgun.net';

  if (!mailgunApiKey || !mailgunDomain) {
    throw new Error('Mailgun API key and domain are required');
  }

  const formData = new FormData();
  formData.append('from', from);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html', html);
  formData.append('o:tracking-clicks', 'no');

  try {
    const response = await axios.post(`${mailgunHost}/v3/${mailgunDomain}/messages`, formData, {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Basic ${Buffer.from(`api:${mailgunApiKey}`).toString('base64')}`,
      },
    });

    return response.data;
  } catch (error) {
    throw new Error(logAxiosError({ error, message: 'Failed to send email via Mailgun' }));
  }
};

/**
 * Sends an email using SMTP via Nodemailer.
 *
 * @async
 * @function sendEmailViaSMTP
 * @param {Object} params - The parameters for sending the email.
 * @param {Object} params.transporterOptions - The transporter configuration options.
 * @param {Object} params.mailOptions - The email options.
 * @returns {Promise<Object>} - A promise that resolves to the info object of the sent email.
 */
const sendEmailViaSMTP = async ({ transporterOptions, mailOptions }) => {
  const transporter = nodemailer.createTransport(transporterOptions);
  return await transporter.sendMail(mailOptions);
};

/**
 * Sends an email using the specified template, subject, and payload.
 *
 * @async
 * @function sendEmail
 * @param {Object} params - The parameters for sending the email.
 * @param {string} params.email - The recipient's email address.
 * @param {string} params.subject - The subject of the email.
 * @param {Record<string, string>} params.payload - The data to be used in the email template.
 * @param {string} params.template - The filename of the email template.
 * @param {boolean} [throwError=true] - Whether to throw an error if the email sending process fails.
 * @returns {Promise<Object>} - A promise that resolves to the info object of the sent email or the error if sending the email fails.
 *
 * @example
 * const emailData = {
 *   email: 'recipient@example.com',
 *   subject: 'Welcome!',
 *   payload: { name: 'Recipient' },
 *   template: 'welcome.html'
 * };
 *
 * sendEmail(emailData)
 *   .then(info => console.log('Email sent:', info))
 *   .catch(error => console.error('Error sending email:', error));
 *
 * @throws Will throw an error if the email sending process fails and throwError is `true`.
 */
const sendEmail = async ({ email, subject, payload, template, throwError = true }) => {
  try {
    const { content: source } = await readFileAsString(path.join(__dirname, 'emails', template));
    const compiledTemplate = handlebars.compile(source);
    const html = compiledTemplate(payload);

    // Prepare common email data
    const fromName = process.env.EMAIL_FROM_NAME || process.env.APP_TITLE;
    const fromEmail = process.env.EMAIL_FROM;
    const fromAddress = `"${fromName}" <${fromEmail}>`;
    const toAddress = `"${payload.name}" <${email}>`;

    // Check if Mailgun is configured
    if (process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN) {
      logger.debug('[sendEmail] Using Mailgun provider');
      return await sendEmailViaMailgun({
        from: fromAddress,
        to: toAddress,
        subject: subject,
        html: html,
      });
    }

    // Default to SMTP
    logger.debug('[sendEmail] Using SMTP provider');
    const transporterOptions = {
      // Use STARTTLS by default instead of obligatory TLS
      secure: process.env.EMAIL_ENCRYPTION === 'tls',
      // If explicit STARTTLS is set, require it when connecting
      requireTLS: process.env.EMAIL_ENCRYPTION === 'starttls',
      tls: {
        // Whether to accept unsigned certificates
        rejectUnauthorized: !isEnabled(process.env.EMAIL_ALLOW_SELFSIGNED),
      },
    };

    const hasUsername = !!process.env.EMAIL_USERNAME;
    const hasPassword = !!process.env.EMAIL_PASSWORD;
    if (hasUsername && hasPassword) {
      transporterOptions.auth = {
        user: process.env.EMAIL_USERNAME,
        pass: process.env.EMAIL_PASSWORD,
      };
    } else if (hasUsername !== hasPassword) {
      logger.warn(
        '[sendEmail] EMAIL_USERNAME and EMAIL_PASSWORD must both be set for authenticated SMTP, or both omitted for unauthenticated SMTP. Proceeding without authentication.',
      );
    }

    if (process.env.EMAIL_ENCRYPTION_HOSTNAME) {
      // Check the certificate against this name explicitly
      transporterOptions.tls.servername = process.env.EMAIL_ENCRYPTION_HOSTNAME;
    }

    // Mailer service definition has precedence
    if (process.env.EMAIL_SERVICE) {
      transporterOptions.service = process.env.EMAIL_SERVICE;
    } else {
      transporterOptions.host = process.env.EMAIL_HOST;
      transporterOptions.port = process.env.EMAIL_PORT ?? 25;
    }

    const mailOptions = {
      // Header address should contain name-addr
      from: fromAddress,
      to: toAddress,
      envelope: {
        // Envelope from should contain addr-spec
        // Mistake in the Nodemailer documentation?
        from: fromEmail,
        to: email,
      },
      subject: subject,
      html: html,
    };

    return await sendEmailViaSMTP({ transporterOptions, mailOptions });
  } catch (error) {
    if (throwError) {
      throw error;
    }
    logger.error('[sendEmail]', error);
    return error;
  }
};

module.exports = sendEmail;
