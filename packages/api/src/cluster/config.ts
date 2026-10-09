import { math } from '~/utils';

const clusterConfig: {
  /** Duration in seconds that the leader lease is valid before it expires */
  LEADER_LEASE_DURATION: number;
  /** Interval in seconds at which the leader renews its lease */
  LEADER_RENEW_INTERVAL: number;
  /** Maximum number of retry attempts when renewing the lease fails */
  LEADER_RENEW_ATTEMPTS: number;
  /** Delay in seconds between retry attempts when renewing the lease */
  LEADER_RENEW_RETRY_DELAY: number;
} = {
  /** Duration in seconds that the leader lease is valid before it expires */
  LEADER_LEASE_DURATION: math(process.env.LEADER_LEASE_DURATION, 25),
  /** Interval in seconds at which the leader renews its lease */
  LEADER_RENEW_INTERVAL: math(process.env.LEADER_RENEW_INTERVAL, 10),
  /** Maximum number of retry attempts when renewing the lease fails */
  LEADER_RENEW_ATTEMPTS: math(process.env.LEADER_RENEW_ATTEMPTS, 3),
  /** Delay in seconds between retry attempts when renewing the lease */
  LEADER_RENEW_RETRY_DELAY: math(process.env.LEADER_RENEW_RETRY_DELAY, 0.5),
};

export { clusterConfig };
