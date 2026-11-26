import { ViolationTypes } from 'librechat-data-provider';

interface BanRequest {
  ip?: string;
}

interface BanResponse {
  clearCookie(name: string): void;
  status(): BanResponse;
  json(): BanResponse;
}

interface BanMessage {
  type: ViolationTypes;
  violation_count: number;
  user_id: string;
  prev_count: number;
  duration: number;
  ban?: boolean;
  ban_duration?: number;
}

interface BanUserCommandDependencies {
  args: string[];
  askQuestion(question: string): Promise<string>;
  findUserByEmail(email: string): Promise<{
    _id: string | { toString(): string };
    email?: string;
  } | null>;
  banViolation(req: BanRequest, res: BanResponse, message: BanMessage): Promise<void>;
  purple(message: string): void;
  orange(message: string): void;
  red(message: string): void;
}

export async function runBanUserCommand(deps: BanUserCommandDependencies): Promise<0 | 1> {
  deps.purple('---------------------');
  deps.purple('Ban a user account!');
  deps.purple('---------------------');

  let email = '';
  let duration = 0;
  if (deps.args.length >= 2) {
    email = deps.args[0];
    duration = parseInt(deps.args[1]);
  } else {
    deps.orange('Usage: npm run ban-user <email> <duration>');
    deps.orange('Note: if you do not pass in the arguments, you will be prompted for them.');
    deps.purple('--------------------------');
  }

  if (!email) {
    email = await deps.askQuestion('Email:');
  }
  if (!duration) {
    const minutes = await deps.askQuestion('Duration (in minutes):');
    duration = parseInt(minutes) * 60000;
  }
  if (isNaN(duration) || duration <= 0) {
    deps.red('Error: Invalid duration!');
    return 1;
  }
  if (!email.includes('@')) {
    deps.red('Error: Invalid email address!');
    return 1;
  }

  const user = await deps.findUserByEmail(email);
  if (!user) {
    deps.red('Error: No user with that email was found!');
    return 1;
  }
  deps.purple(`Found user: ${user.email}`);

  const res: BanResponse = {
    clearCookie: () => {},
    status() {
      return this;
    },
    json() {
      return this;
    },
  };
  await deps.banViolation({}, res, {
    type: ViolationTypes.CONCURRENT,
    violation_count: 20,
    user_id: String(user._id),
    prev_count: 0,
    duration,
  });
  return 0;
}
