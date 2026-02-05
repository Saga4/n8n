import type { CronExpression } from './interfaces';
import { randomInt } from './utils';

interface BaseTriggerTime<T extends string> {
	mode: T;
}

interface CustomTrigger extends BaseTriggerTime<'custom'> {
	cronExpression: CronExpression;
}

interface EveryX<U extends string> extends BaseTriggerTime<'everyX'> {
	unit: U;
	value: number;
}

type EveryMinute = BaseTriggerTime<'everyMinute'>;
type EveryXMinutes = EveryX<'minutes'>;

interface EveryHour extends BaseTriggerTime<'everyHour'> {
	minute: number; // 0 - 59
}
type EveryXHours = EveryX<'hours'>;

interface EveryDay extends BaseTriggerTime<'everyDay'> {
	hour: number; // 0 - 23
	minute: number; // 0 - 59
}

interface EveryWeek extends BaseTriggerTime<'everyWeek'> {
	hour: number; // 0 - 23
	minute: number; // 0 - 59
	weekday: number; // 0 - 6(Sun - Sat)
}

interface EveryMonth extends BaseTriggerTime<'everyMonth'> {
	hour: number; // 0 - 23
	minute: number; // 0 - 59
	dayOfMonth: number; // 1 - 31
}

export type TriggerTime =
	| CustomTrigger
	| EveryMinute
	| EveryXMinutes
	| EveryHour
	| EveryXHours
	| EveryDay
	| EveryWeek
	| EveryMonth;

export const toCronExpression = (item: TriggerTime): CronExpression => {
	// Quick path for custom mode: avoid generating any random values.
	if (item.mode === 'custom') return item.cronExpression.trim() as CronExpression;

	// Only generate random values when needed, and generate the minimum required.
	const randomSecond = randomInt(60);
	const mode = item.mode;

	if (mode === 'everyMinute') return `${randomSecond} * * * * *`;
	if (mode === 'everyHour') return `${randomSecond} ${item.minute} * * * *`;

	if (mode === 'everyX') {
		if (item.unit === 'minutes') return `${randomSecond} */${item.value} * * * *`;

		// only generate randomMinute for hours unit
		const randomMinute = randomInt(60);
		if (item.unit === 'hours') return `${randomSecond} ${randomMinute} */${item.value} * * *`;
	}
	if (mode === 'everyDay') return `${randomSecond} ${item.minute} ${item.hour} * * *`;
	if (mode === 'everyWeek')
		return `${randomSecond} ${item.minute} ${item.hour} * * ${item.weekday}`;

	if (mode === 'everyMonth')
		return `${randomSecond} ${item.minute} ${item.hour} ${item.dayOfMonth} * *`;

	// Fallback (should be unreachable because custom handled above)
	return item.cronExpression.trim() as CronExpression;
};
