import process from 'node:process';
import { loadReviewerModule } from './common.mjs';
const presentation = await loadReviewerModule('presentation');
const github = await loadReviewerModule('github');
export const { readHistory, withHistory, runRecord, reviewMarker } = presentation;
export const findReviewComment = (c) =>
    github.findReviewComment(c, github.githubRequester(c.repository, process.env.GH_READ_TOKEN));
