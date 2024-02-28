import moment from 'moment'; //RETASK: ADDED
import { MenuItem, Notice } from 'obsidian';
import type { Moment, unitOfTime } from 'moment/moment';
import type { Task } from '../../Task/Task';
import {
    type HappensDate,
    createFixedDateTask,
    createPostponedTask,
    fixedDateMenuItemTitle,
    getDateFieldToPostpone,
    postponeMenuItemTitle,
    postponementSuccessMessage,
} from '../../Scripting/Postponer';
import { TaskEditingMenu, type TaskSaver, defaultTaskSaver } from './TaskEditingMenu';

type NamingFunction = (task: Task, amount: number, timeUnit: unitOfTime.DurationConstructor) => string;

type PostponingFunction = (
    task: Task,
    dateFieldToPostpone: HappensDate,
    timeUnit: unitOfTime.DurationConstructor,
    amount: number,
) => {
    postponedDate: moment.Moment;
    postponedTask: Task;
};

export class PostponeMenu extends TaskEditingMenu {
    constructor(button: HTMLAnchorElement, task: Task, taskSaver: TaskSaver = defaultTaskSaver) {
        super(taskSaver);

        const postponeMenuItemCallback = (
            button: HTMLAnchorElement,
            item: MenuItem,
            timeUnit: unitOfTime.DurationConstructor,
            amount: number,
            itemNamingFunction: NamingFunction,
            postponingFunction: PostponingFunction,
        ) => {
            const title = itemNamingFunction(task, amount, timeUnit);
            // TODO Call setChecked() to put a checkmark against the item, if it represents the current task field value.
            item.setTitle(title).onClick(() =>
                PostponeMenu.postponeOnClickCallback(button, task, amount, timeUnit, postponingFunction, taskSaver),
            );
        };

     // RETASK: REMOVED
     // const fixedTitle = fixedDateMenuItemTitle;
     // const fixedDateFunction = createFixedDateTask;
     // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 0, fixedTitle, fixedDateFunction));
     // this.addItem((item) => postponeMenuItemCallback(button, item, 'day', 1, fixedTitle, fixedDateFunction));

     // this.addSeparator();

        const titlingFunction = postponeMenuItemTitle;
        const postponingFunction = createPostponedTask;
        this.addItem((item) => postponeMenuItemCallback(button, item, 'day', 1, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 2, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 3, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 4, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 5, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 6, titlingFunction, postponingFunction));
        // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 7, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'week', 1, titlingFunction, postponingFunction));

        this.addSeparator();

        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 8, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 9, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 10, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 11, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 12, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 13, titlingFunction, postponingFunction));
        // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 14, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'weeks', 2, titlingFunction, postponingFunction));

        // this.addSeparator();

        // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 15, titlingFunction, postponingFunction));
        // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 16, titlingFunction, postponingFunction));
        // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 17, titlingFunction, postponingFunction));
        // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 18, titlingFunction, postponingFunction));
        // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 19, titlingFunction, postponingFunction));
        // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 20, titlingFunction, postponingFunction));
        // this.addItem((item) => postponeMenuItemCallback(button, item, 'days', 21, titlingFunction, postponingFunction));

        this.addSeparator();

        // this.addItem((item) => postponeMenuItemCallback(button, item, 'week', 1, titlingFunction, postponingFunction));
        // this.addItem((item) => postponeMenuItemCallback(button, item, 'weeks', 2, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'weeks', 3, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'month', 1, titlingFunction, postponingFunction));

        // RETASK: ADD
        this.addSeparator();

        this.addItem((item) => postponeMenuItemCallback(button, item, 'month', 2, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'month', 3, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'month', 4, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'month', 5, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'month', 6, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'month', 9, titlingFunction, postponingFunction));
        this.addItem((item) => postponeMenuItemCallback(button, item, 'year', 1, titlingFunction, postponingFunction));
    }

    public static async postponeOnClickCallback(
        button: HTMLAnchorElement,
        task: Task,
        amount: number,
        timeUnit: unitOfTime.DurationConstructor,
        postponingFunction: PostponingFunction = createPostponedTask,
        taskSaver: TaskSaver = defaultTaskSaver,
    ) {
        const dateFieldToPostpone = getDateFieldToPostpone(task);
        if (dateFieldToPostpone === null) {
            const errorMessage = '⚠️ Postponement requires a date: due, scheduled or start.';
            return new Notice(errorMessage, 10000);
        }

        // RETASK: ADD
        // RETASK: This function acts when the task postpone arrows are right clicked.
        async function asyncCall() {
            // MAKE ARRAY FROM SOURCE FILE and splice the task out of it
            const sourceFileArray = await app.vault.adapter
                .read(task.taskLocation.path)
                .then((fileString) => fileString.split('\n'));

            sourceFileArray.splice(task.taskLocation.lineNumber, 1);

            // IF THIS IS TRUE WE ARE USING THE SAME FILE FOR SOURCE AND DESTINATION SO SOMETHING IS WRONG
            if (task.taskLocation.path == app.workspace.activeEditor?.file?.path) return;

            // determine if the currently open file date is in the past/present or in the future
            // if the day is in the past or present, we add duration to current date.
            // if the day is in the future we use that file's date as the relative date for postpoining
            let targetDate = moment().startOf('day');
            if (targetDate >= moment(task.filename, 'YYYY-MM-DD')) {
                targetDate = targetDate.add(amount, timeUnit); // day is in the past/present
            } else {
                targetDate = moment(task.filename, 'YYYY-MM-DD').add(amount, timeUnit); // day is in the future
            }

            const DD = targetDate.toDate().getDate();
            const MM = targetDate.toDate().getMonth() + 1; // 0 is January, so we must add 1
            const YYYY = targetDate.toDate().getFullYear();

            // below makes a string similar to this > periodic-notes/2024/2024-01/2024-01-08.md
            const targetPathString =
                'periodic-notes/' +
                YYYY +
                '/' +
                YYYY +
                '-' +
                MM.toString().padStart(2, '0') +
                '/' +
                YYYY +
                '-' +
                MM.toString().padStart(2, '0') +
                '-' +
                DD.toString().padStart(2, '0') +
                '.md';

            const targetYearFolderPathString = 'periodic-notes/' + YYYY;
            const targetMonthFolderPathString =
                'periodic-notes/' + YYYY + '/' + YYYY + '-' + MM.toString().padStart(2, '0');

            // MAKE ARRAY OUT OF DESTINATION FILE and make path if file doesn't exist. fill new file with template.
            let destinationFileArray: any = [];

            if (await app.vault.adapter.exists(targetPathString)) {
                destinationFileArray = await app.vault.adapter
                    .read(targetPathString)
                    .then((result) => result.split('\n'));
            } else {
                // make year folder if it doesnt exist
                if (!(await app.vault.adapter.exists(targetYearFolderPathString))) {
                    await app.vault.adapter.mkdir(targetYearFolderPathString);
                }
                // make month folder if it doesnt exist
                if (!(await app.vault.adapter.exists(targetMonthFolderPathString))) {
                    await app.vault.adapter.mkdir(targetMonthFolderPathString);
                }
                // fill new file with template contents but strip out the cursor line.
                let dailyTemplate = await app.vault.adapter.read('Templates/daily.md');
                dailyTemplate = dailyTemplate.replace(
                    '<% tp.file.cursor() %><%* app.workspace.activeLeaf.view.editor?.focus(); %>',
                    '',
                );
                await app.vault.create(targetPathString, dailyTemplate);
                destinationFileArray = await app.vault.adapter
                    .read(targetPathString)
                    .then((result) => result.split('\n'));
            }

            // DETERMINE RETASK INPUT LOCATION IN DESTINATION FILE
            const markerString = '<= retask =>';
            let lastloc = destinationFileArray?.lastIndexOf(markerString);

            // LOGIC: if lastloc =-1 then not found so we just append line to destfile otherwise we use lastloc + 1
            // we want to input at the end of the file or on top of the retask marker string
            if (lastloc == -1) lastloc = destinationFileArray.length;
            destinationFileArray.splice(lastloc, 0, task.originalMarkdown);

            await app.vault.adapter.write(targetPathString, destinationFileArray.join('\n'));
            await app.vault.adapter.write(task.taskLocation.path, sourceFileArray.join('\n'));
        }
        asyncCall();    
        
        //RETASK: REMOVE
        // const { postponedDate, postponedTask } = postponingFunction(task, dateFieldToPostpone, timeUnit, amount);
        
        // await taskSaver(task, postponedTask);
        // PostponeMenu.postponeSuccessCallback(button, dateFieldToPostpone, postponedDate);
    }

    private static postponeSuccessCallback(
        button: HTMLAnchorElement,
        updatedDateType: HappensDate,
        postponedDate: Moment,
    ) {
        // Disable the button to prevent update error due to the task not being reloaded yet.
        button.style.pointerEvents = 'none';

        const successMessage = postponementSuccessMessage(postponedDate, updatedDateType);
        new Notice(successMessage, 2000);
    }
}
