import { registry } from '@/commands';
import { statusCommand } from '@/commands/status';
import { tasksCommand } from '@/commands/tasks';
import { defaultCommand } from '@/commands/default';

registry.register(statusCommand);
registry.register(tasksCommand);
registry.register(defaultCommand);
