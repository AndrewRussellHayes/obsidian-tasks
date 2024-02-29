import type { EventRef, MarkdownPostProcessorContext } from 'obsidian';
import { App, Keymap, MarkdownRenderChild, MarkdownRenderer, TFile } from 'obsidian';
import { GlobalFilter } from '../Config/GlobalFilter';
import { GlobalQuery } from '../Config/GlobalQuery';
import { QueryLayout } from '../Layout/QueryLayout';
import { DateFallback } from '../Task/DateFallback';

import type { IQuery } from '../IQuery';
import { explainResults, getQueryForQueryRenderer } from '../lib/QueryRendererHelper';
import type { GroupDisplayHeading } from '../Query/Group/GroupDisplayHeading';
import type { QueryResult } from '../Query/QueryResult';
import type { TaskGroups } from '../Query/Group/TaskGroups';
import { postponeButtonTitle, shouldShowPostponeButton } from '../Scripting/Postponer';
import type { Task } from '../Task/Task';
import { TaskLayout } from '../Layout/TaskLayout';
import { PostponeMenu } from '../ui/Menus/PostponeMenu';
import type TasksPlugin from '../main';
import { TaskModal } from '../Obsidian/TaskModal';
import type { TasksEvents } from '../Obsidian/TasksEvents';
import { getTaskLineAndFile, replaceTaskWithTasks } from '../Obsidian/File';
import { State } from '../Obsidian/Cache';
import { TaskLineRenderer, createAndAppendElement } from './TaskLineRenderer';

export class QueryRenderer {
    private readonly app: App;
    private plugin: TasksPlugin;
    private readonly events: TasksEvents;

    constructor({ plugin, events }: { plugin: TasksPlugin; events: TasksEvents }) {
        this.app = plugin.app;
        this.plugin = plugin;
        this.events = events;

        plugin.registerMarkdownCodeBlockProcessor('tasks', this._addQueryRenderChild.bind(this));
    }

    public addQueryRenderChild = this._addQueryRenderChild.bind(this);

    private async _addQueryRenderChild(source: string, element: HTMLElement, context: MarkdownPostProcessorContext) {
        context.addChild(
            new QueryRenderChild({
                app: this.app,
                plugin: this.plugin,
                events: this.events,
                container: element,
                source,
                filePath: context.sourcePath,
            }),
        );
    }
}

class QueryRenderChild extends MarkdownRenderChild {
    private readonly app: App;
    private plugin: TasksPlugin;
    private readonly events: TasksEvents;

    /**
     * The complete text in the instruction block, such as:
     * ```
     *   not done
     *   short mode
     * ```
     *
     * This does not contain the Global Query from the user's settings.
     * Use {@link getQueryForQueryRenderer} to get this value prefixed with the Global Query.
     */
    private readonly source: string;

    /// The path of the file that contains the instruction block.
    private readonly filePath: string;

    private query: IQuery;
    // @ts-expect-error: TS6133: 'queryType' is declared but its value is never read
    private queryType: string; // whilst there is only one query type, there is no point logging this value

    private renderEventRef: EventRef | undefined;
    private queryReloadTimeout: NodeJS.Timeout | undefined;

    constructor({
        app,
        plugin,
        events,
        container,
        source,
        filePath,
    }: {
        app: App;
        plugin: TasksPlugin;
        events: TasksEvents;
        container: HTMLElement;
        source: string;
        filePath: string;
    }) {
        super(container);

        this.app = app;
        this.plugin = plugin;
        this.events = events;
        this.source = source;
        this.filePath = filePath;

        // The engine is chosen on the basis of the code block language. Currently,
        // there is only the main engine for the plugin, this allows others to be
        // added later.
        switch (this.containerEl.className) {
            case 'block-language-tasks':
                this.query = getQueryForQueryRenderer(this.source, GlobalQuery.getInstance(), this.filePath);
                this.queryType = 'tasks';
                break;

            default:
                this.query = getQueryForQueryRenderer(this.source, GlobalQuery.getInstance(), this.filePath);
                this.queryType = 'tasks';
                break;
        }
    }

    onload() {
        // Process the current cache state:
        this.events.triggerRequestCacheUpdate(this.render.bind(this));
        // Listen to future cache changes:
        this.renderEventRef = this.events.onCacheUpdate(this.render.bind(this));

        this.reloadQueryAtMidnight();
    }

    onunload() {
        if (this.renderEventRef !== undefined) {
            this.events.off(this.renderEventRef);
        }

        if (this.queryReloadTimeout !== undefined) {
            clearTimeout(this.queryReloadTimeout);
        }
    }

    /**
     * Reloads the query after midnight to update results from relative date queries.
     *
     * For example, the query `due today` changes every day. This makes sure that all query results
     * are re-rendered after midnight every day to ensure up-to-date results without having to
     * reload obsidian. Creating a new query object from the source re-applies the relative dates
     * to "now".
     */
    private reloadQueryAtMidnight(): void {
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        const now = new Date();

        const millisecondsToMidnight = midnight.getTime() - now.getTime();

        this.queryReloadTimeout = setTimeout(() => {
            this.query = getQueryForQueryRenderer(this.source, GlobalQuery.getInstance(), this.filePath);
            // Process the current cache state:
            this.events.triggerRequestCacheUpdate(this.render.bind(this));
            this.reloadQueryAtMidnight();
        }, millisecondsToMidnight + 1000); // Add buffer to be sure to run after midnight.
    }

    private async render({ tasks, state }: { tasks: Task[]; state: State }) {
        // Don't log anything here, for any state, as it generates huge amounts of
        // console messages in large vaults, if Obsidian was opened with any
        // notes with tasks code blocks in Reading or Live Preview mode.

        const content = createAndAppendElement('div', this.containerEl);
        if (state === State.Warm && this.query.error === undefined) {
            await this.renderQuerySearchResults(tasks, state, content);
        } else if (this.query.error !== undefined) {
            this.renderErrorMessage(content, this.query.error);
        } else {
            this.renderLoadingMessage(content);
        }

        this.containerEl.firstChild?.replaceWith(content);
    }

    private async renderQuerySearchResults(tasks: Task[], state: State.Warm, content: HTMLDivElement) {
        // See https://github.com/obsidian-tasks-group/obsidian-tasks/issues/2160
        this.query.debug(`[render] Render called: plugin state: ${state}; searching ${tasks.length} tasks`);

        if (this.query.queryLayoutOptions.explainQuery) {
            this.createExplanation(content);
        }

        const queryResult = this.query.applyQueryToTasks(tasks);
        if (queryResult.searchErrorMessage !== undefined) {
            // There was an error in the search, for example due to a problem custom function.
            this.renderErrorMessage(content, queryResult.searchErrorMessage);
            return;
        }

        await this.addAllTaskGroups(queryResult.taskGroups, content);

        const totalTasksCount = queryResult.totalTasksCount;
        this.addTaskCount(content, queryResult);

        this.query.debug(`[render] ${totalTasksCount} tasks displayed`);
    }

    private renderErrorMessage(content: HTMLDivElement, errorMessage: string) {
        content.createDiv().innerHTML = '<pre>' + `Tasks query: ${errorMessage.replace(/\n/g, '<br>')}` + '</pre>';
    }

    private renderLoadingMessage(content: HTMLDivElement) {
        content.setText('Loading Tasks ...');
    }

    // Use the 'explain' instruction to enable this
    private createExplanation(content: HTMLDivElement) {
        const explanationAsString = explainResults(
            this.source,
            GlobalFilter.getInstance(),
            GlobalQuery.getInstance(),
            this.filePath,
        );

        const explanationsBlock = createAndAppendElement('pre', content);
        explanationsBlock.addClasses(['plugin-tasks-query-explanation']);
        explanationsBlock.setText(explanationAsString);
        content.appendChild(explanationsBlock);
    }

    private async createTaskList(tasks: Task[], content: HTMLDivElement): Promise<void> {
        const taskList = createAndAppendElement('ul', content);

        taskList.addClasses(['contains-task-list', 'plugin-tasks-query-result']);
        const taskLayout = new TaskLayout(this.query.taskLayoutOptions);
        taskList.addClasses(taskLayout.generateHiddenClasses());
        const queryLayout = new QueryLayout(this.query.queryLayoutOptions);
        taskList.addClasses(queryLayout.getHiddenClasses());

        const groupingAttribute = this.getGroupingAttribute();
        if (groupingAttribute && groupingAttribute.length > 0) taskList.dataset.taskGroupBy = groupingAttribute;

        const taskLineRenderer = new TaskLineRenderer({
            obsidianComponent: this,
            parentUlElement: taskList,
            taskLayoutOptions: this.query.taskLayoutOptions,
            queryLayoutOptions: this.query.queryLayoutOptions,
        });

        for (const [taskIndex, task] of tasks.entries()) {
            const isFilenameUnique = this.isFilenameUnique({ task });
            const listItem = await taskLineRenderer.renderTaskLine(task, taskIndex, isFilenameUnique);

            // Remove all footnotes. They don't re-appear in another document.
            const footnotes = listItem.querySelectorAll('[data-footnote-id]');
            footnotes.forEach((footnote) => footnote.remove());

            const extrasSpan = listItem.createSpan('task-extras');

            if (!this.query.queryLayoutOptions.hideUrgency) {
                this.addUrgency(extrasSpan, task);
            }

            const shortMode = this.query.queryLayoutOptions.shortMode;

            if (!this.query.queryLayoutOptions.hideBacklinks) {
                this.addBacklinks(extrasSpan, task, shortMode, isFilenameUnique);
            }

            if (!this.query.queryLayoutOptions.hideEditButton) {
                // TODO Need to explore what happens if a tasks code block is rendered before the Cache has been created.
                this.addEditButton(extrasSpan, task, this.plugin.getTasks()!);
            }

            if (!this.query.queryLayoutOptions.hidePostponeButton && shouldShowPostponeButton(task)) {
                this.addPostponeButton(extrasSpan, task, shortMode);
            }

            // NEW
            // if (!this.query.layoutOptions.hideSnoozeButton) {
            //     this.addUnSnoozeButton(extrasSpan, task, shortMode);
            //     this.addSnoozeButton1Day(extrasSpan, task, shortMode);
            //     this.addSnoozeButton3Days(extrasSpan, task, shortMode);
            // }

            taskList.appendChild(listItem);
        }

        content.appendChild(taskList);
    }

    private addEditButton(listItem: HTMLElement, task: Task, allTasks: Task[]) {
        const editTaskPencil = createAndAppendElement('a', listItem);
        editTaskPencil.addClass('tasks-edit');
        editTaskPencil.title = 'Edit task';
        editTaskPencil.href = '#';

        editTaskPencil.onClickEvent((event: MouseEvent) => {
            event.preventDefault();

                        // RETASK: ADD
            // Function executes when the pencil is left clicked.
            async function asyncCall() {
                // MAKE ARRAY FROM SOURCE FILE and splice the task out of it
                const sourceFileArray = await app.vault.adapter
                    .read(task.taskLocation.path)
                    .then((fileString) => fileString.split('\n'));

                sourceFileArray.splice(task.taskLocation.lineNumber, 1);

                // IF THIS IS TRUE WE ARE USING THE SAME FILE FOR SOURCE AND DESTINATION SO SOMETHING IS WRONG
                if (task.taskLocation.path == app.workspace.activeEditor?.file?.path) return;

                // determine destination file. if the currently open file is today or the future then pen moves task to currently open file.
                // if the currently open file is in the past, then pen moves the task to "today"
                const pencilOpenFileDate = new Date(
                    Date.parse(app.workspace.activeEditor?.file?.basename + ' 00:00:00'),
                );
                const today = new Date();
                const fileInPast = pencilOpenFileDate < today;

                const DD = today.getDate();
                const MM = today.getMonth() + 1; // 0 is January, so we must add 1
                const YYYY = today.getFullYear();

                // below makes a string similar to this > periodic-notes/2024/2024-01/2024-01-08.md
                const todayPathString =
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

                const todayYearFolderPathString = 'periodic-notes/' + YYYY;
                const todayMonthFolderPathString =
                    'periodic-notes/' + YYYY + '/' + YYYY + '-' + MM.toString().padStart(2, '0');

                // MAKE ARRAY OUT OF DESTINATION FILE and make path if file doesn't exist. fill new file with template.
                let destinationFileArray: any = [];

                if (fileInPast) {
                    if (await app.vault.adapter.exists(todayPathString)) {
                        destinationFileArray = await app.vault.adapter
                            .read(todayPathString)
                            .then((result) => result.split('\n'));
                    } else {
                        // make year folder if it doesnt exist
                        if (!(await app.vault.adapter.exists(todayYearFolderPathString))) {
                            await app.vault.adapter.mkdir(todayYearFolderPathString);
                        }
                        // make month folder if it doesnt exist
                        if (!(await app.vault.adapter.exists(todayMonthFolderPathString))) {
                            await app.vault.adapter.mkdir(todayMonthFolderPathString);
                        }

                        let dailyTemplate = await app.vault.adapter.read('Templates/daily.md');
                        dailyTemplate = dailyTemplate.replace(
                            '<% tp.file.cursor() %><%* app.workspace.activeLeaf.view.editor?.focus(); %>',
                            '',
                        );
                        await app.vault.create(todayPathString, dailyTemplate);
                        destinationFileArray = await app.vault.adapter
                            .read(todayPathString)
                            .then((result) => result.split('\n'));
                    }
                } else {
                    if (app.workspace.activeEditor?.file) {
                        destinationFileArray = await app.vault.adapter
                            .read(app.workspace.activeEditor?.file?.path)
                            .then((result) => result.split('\n'));
                    }
                }

                // DETERMINE RETASK INPUT LOCATION IN DESTINATION FILE
                const markerString = '<= retask =>';
                let lastloc = destinationFileArray?.lastIndexOf(markerString);

                // LOGIC: if lastloc =-1 then not found so we just append line to destfile otherwise we use lastloc + 1
                // we want to input at the end of the file or on top of the retask marker string
                if (lastloc == -1) lastloc = destinationFileArray.length;
                destinationFileArray.splice(lastloc, 0, task.originalMarkdown);

                // if file is in the past then the destination of the write is today, if its today or the future the destination of the write is the open file in the window (this could be moved to block above)
                if (fileInPast) {
                    await app.vault.adapter.write(todayPathString!, destinationFileArray.join('\n'));
                } else {
                    await app.vault.adapter.write(
                        app.workspace.activeEditor?.file?.path!,
                        destinationFileArray.join('\n'),
                    );
                }
                await app.vault.adapter.write(task.taskLocation.path, sourceFileArray.join('\n'));
            }
            asyncCall();

            const onSubmit = async (updatedTasks: Task[]): Promise<void> => {
                await replaceTaskWithTasks({
                    originalTask: task,
                    newTasks: DateFallback.removeInferredStatusIfNeeded(task, updatedTasks),
                });
            };

            // Need to create a new instance every time, as cursor/task can change.
            const taskModal = new TaskModal({
                app: this.app,
                task,
                onSubmit,
                allTasks,
            });
            // taskModal.open(); //RETASK: REMOVE     
        });
    }

    private addUrgency(listItem: HTMLElement, task: Task) {
        const text = new Intl.NumberFormat().format(task.urgency);
        listItem.createSpan({ text, cls: 'tasks-urgency' });
    }

    private async addAllTaskGroups(tasksSortedLimitedGrouped: TaskGroups, content: HTMLDivElement) {
        for (const group of tasksSortedLimitedGrouped.groups) {
            // If there were no 'group by' instructions, group.groupHeadings
            // will be empty, and no headings will be added.
            await this.addGroupHeadings(content, group.groupHeadings);

            await this.createTaskList(group.tasks, content);
        }
    }

    /**
     * Display headings for a group of tasks.
     * @param content
     * @param groupHeadings - The headings to display. This can be an empty array,
     *                        in which case no headings will be added.
     * @private
     */
    private async addGroupHeadings(content: HTMLDivElement, groupHeadings: GroupDisplayHeading[]) {
        for (const heading of groupHeadings) {
            await this.addGroupHeading(content, heading);
        }
    }

    private async addGroupHeading(content: HTMLDivElement, group: GroupDisplayHeading) {
        // Headings nested to 2 or more levels are all displayed with 'h6:
        let header: keyof HTMLElementTagNameMap = 'h6';
        if (group.nestingLevel === 0) {
            header = 'h4';
        } else if (group.nestingLevel === 1) {
            header = 'h5';
        }

        const headerEl = createAndAppendElement(header, content);
        headerEl.addClass('tasks-group-heading');
        await MarkdownRenderer.renderMarkdown(group.displayName, headerEl, this.filePath, this);
    }

    private addBacklinks(listItem: HTMLElement, task: Task, shortMode: boolean, isFilenameUnique: boolean | undefined) {
        const backLink = listItem.createSpan({ cls: 'tasks-backlink' });

        if (!shortMode) {
            backLink.append(' (');
        }

        const link = createAndAppendElement('a', backLink);

        link.rel = 'noopener';
        link.target = '_blank';
        link.addClass('internal-link');
        if (shortMode) {
            link.addClass('internal-link-short-mode');
        }

        let linkText: string;
        if (shortMode) {
            linkText = ' 🔗';
        } else {
            linkText = task.getLinkText({ isFilenameUnique }) ?? '';
        }

        link.setText(linkText);

        // Go to the line the task is defined at
        const vault = this.app.vault;
        link.addEventListener('click', async (ev: MouseEvent) => {
            const result = await getTaskLineAndFile(task, vault);
            if (result) {
                const [line, file] = result;
                const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(ev));
                // When the corresponding task has been found,
                // suppress the default behavior of the mouse click event
                // (which would interfere e.g. if the query is rendered inside a callout).
                ev.preventDefault();
                // Instead of the default behavior, open the file with the required line highlighted.
                await leaf.openFile(file, { eState: { line: line } });
            }
        });

        link.addEventListener('mousedown', async (ev: MouseEvent) => {
            // Open in a new tab on middle-click.
            // This distinction is not available in the 'click' event, so we handle the 'mousedown' event
            // solely for this.
            // (for regular left-click we prefer the 'click' event, and not to just do everything here, because
            // the 'click' event is more generic for touch devices etc.)
            if (ev.button === 1) {
                const result = await getTaskLineAndFile(task, vault);
                if (result) {
                    const [line, file] = result;
                    const leaf = this.app.workspace.getLeaf('tab');
                    ev.preventDefault();
                    await leaf.openFile(file, { eState: { line: line } });
                }
            }
        });

        if (!shortMode) {
            backLink.append(')');
        }
    }

    private addPostponeButton(listItem: HTMLElement, task: Task, shortMode: boolean) {
        const amount = 1;
        const timeUnit = 'day';
        const buttonTooltipText = postponeButtonTitle(task, amount, timeUnit);

        const button = createAndAppendElement('a', listItem);
        button.addClass('tasks-postpone');
        if (shortMode) {
            button.addClass('tasks-postpone-short-mode');
        }
        button.title = buttonTooltipText;

        button.addEventListener('click', (ev: MouseEvent) => {
            ev.preventDefault(); // suppress the default click behavior
            ev.stopPropagation(); // suppress further event propagation

            // RETASK: ADD
            // RETASK: This function acts when the arrows are left clicked.
            async function asyncCall() {
                // MAKE ARRAY FROM SOURCE FILE and splice the task out of it
                const sourceFileArray = await app.vault.adapter
                    .read(task.taskLocation.path)
                    .then((fileString) => fileString.split('\n'));

                sourceFileArray.splice(task.taskLocation.lineNumber, 1);

                // IF THIS IS TRUE WE ARE USING THE SAME FILE FOR SOURCE AND DESTINATION SO SOMETHING IS WRONG
                if (task.taskLocation.path == app.workspace.activeEditor?.file?.path) return;

                //determine destination file (file names are dates so. find the date of the current open file and then add one to it)
                const today = new Date();

                const todayDD = today.getDate();
                const todayMM = today.getMonth() + 1; // 0 is January, so we must add 1
                const todayYYYY = today.getFullYear();

                const ymdfmt = todayYYYY + '-' + todayMM.toString().padStart(2, '0') + '-' + todayDD.toString().padStart(2, '0');

                const openFileDate = new Date(Date.parse(app.workspace.activeEditor?.file?.basename + ' 00:00:00'));
                let targetDate = new Date(openFileDate.setDate(openFileDate.getDate() + 1));

                const arrowsfileInPast = openFileDate < today;

                if (arrowsfileInPast) {
                    targetDate = new Date(ymdfmt + ' 00:00:00');
                    targetDate.setDate(targetDate.getDate() + 1);
                }

                const DD = targetDate.getDate();
                const MM = targetDate.getMonth() + 1; // 0 is January, so we must add 1
                const YYYY = targetDate.getFullYear();

                const targetDateString =
                    MM.toString().padStart(2, '0') + '/' + DD.toString().padStart(2, '0') + '/' + YYYY;
                // periodic-notes/2024/2024-01/2024-01-08.md
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

                // MAKE ARRAY OUT OF DESTINATION FILE
                let destinationFileArray: any = [];

                if (await app.vault.adapter.exists(targetPathString)) {
                    destinationFileArray = await app.vault.adapter
                        .read(targetPathString)
                        .then((result) => result.split('\n'));
                } else {
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
            
            // PostponeMenu.postponeOnClickCallback(button, task, amount, timeUnit); //RETASK: remove

        });

        /** Open a context menu on right-click.
         */
        button.addEventListener('contextmenu', async (ev: MouseEvent) => {
            ev.preventDefault(); // suppress the default context menu
            ev.stopPropagation(); // suppress further event propagation
            const menu = new PostponeMenu(button, task);
            menu.showAtPosition({ x: ev.clientX, y: ev.clientY });
        });
    }

    private addTaskCount(content: HTMLDivElement, queryResult: QueryResult) {
        if (!this.query.queryLayoutOptions.hideTaskCount) {
            content.createDiv({
                text: queryResult.totalTasksCountDisplayText(),
                cls: 'tasks-count',
            });
        }
    }

    private isFilenameUnique({ task }: { task: Task }): boolean | undefined {
        // Will match the filename without extension (the file's "basename").
        const filenameMatch = task.path.match(/([^/]*)\..+$/i);
        if (filenameMatch === null) {
            return undefined;
        }

        const filename = filenameMatch[1];
        const allFilesWithSameName = this.app.vault.getMarkdownFiles().filter((file: TFile) => {
            if (file.basename === filename) {
                // Found a file with the same name (it might actually be the same file, but we'll take that into account later.)
                return true;
            }
        });

        return allFilesWithSameName.length < 2;
    }

    private getGroupingAttribute() {
        const groupingRules: string[] = [];
        for (const group of this.query.grouping) {
            groupingRules.push(group.property);
        }
        return groupingRules.join(',');
    }
}
