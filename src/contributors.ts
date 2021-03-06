import * as core from '@actions/core'
import * as github from '@actions/github'
import * as Octokit from '@octokit/rest'
import btoa from 'btoa-lite'
import atob from 'atob-lite'

import {IContributor} from './interfaces/IContributor'
import {IGitHubGetContentResponse} from './interfaces/IGitHubGetContentResponse'
import {defaultRC, IContributorRC} from './interfaces/IContributorRC'
import {IFile} from './interfaces/IFile'

const githubToken: string = core.getInput('githubToken')
const contributorsPerRow: number =
  core.getInput('contributorsPerRow') === undefined
    ? 7
    : parseInt(core.getInput('contributorsPerRow'))
const owner: string = github.context.repo.owner
const repo: string = github.context.repo.repo

const markup_badge_start =
  '<!-- CODE-COMMUNITY-BADGE:START - Do not remove or modify this section -->'
const markup_badge_end = '<!-- CODE-COMMUNITY-BADGE:END -->'
const markup_table_start =
  '<!-- CODE-COMMUNITY-LIST:START - Do not remove or modify this section -->'
const markup_table_end = '<!-- CODE-COMMUNITY-LIST:END -->'

let inputFiles: string[] = []
let baseRef: string
let latestCommitSha: string
let treeSha: string
let newTreeSha: string
let contribSha: string

// github.GitHub.plugin(require('octokit-commit-multiple-files'))
const octokit: github.GitHub = new github.GitHub(githubToken)

let contribRC: IContributorRC = defaultRC
let contributor: IContributor

const filesToUpdate: IFile[] = []

export const addContributor = async (contributorToAdd: IContributor) => {
  contributor = contributorToAdd

  contribSha = Math.random()
    .toString(36)
    .slice(2)

  // Ensure that the repo has its .code-communityrc file initialized
  await initializeRC()

  const shouldProceed = updateRC()

  if (shouldProceed) {
    // Load any files that we should review for updates
    await initializeFiles()

    await processFiles()

    await commitContribution()
  }
}

/**
 * Loads an existing .code-communityrc from the repo or
 * creates the contents for a new one.
 */
const initializeRC = async () => {
  try {
    const getRCFileResult = await getFile('.code-communityrc')
    const fileData: IGitHubGetContentResponse = getRCFileResult.data as IGitHubGetContentResponse
    contribRC = JSON.parse(atob(fileData.content.replace(/[\r\n]+/gm, '')))
    core.info('Initialized .code-communityrc file successfully')
  } catch (error) {
    // If we've got an error there is no .code-communityrc file
    core.error(`Unable to retrieve input file: .code-communityrc \n ${error}`)
  }
}

/**
 * For each file mentioned in the .code-communtiyrc add it
 * and its content to the filesToUpdate array.
 */
const initializeFiles = async () => {
  const filesProvided = core.getInput('files')

  if (filesProvided && filesProvided.length) {
    inputFiles = filesProvided.split(',')
  } else {
    inputFiles.push('README.md')
  }

  for (let f = 0; f < inputFiles.length; f++) {
    try {
      const getFileResult = await getFile(inputFiles[f])
      const fileData: IGitHubGetContentResponse = getFileResult.data as IGitHubGetContentResponse
      const fileContent = atob(fileData.content.replace(/[\r\n]+/gm, ''))

      filesToUpdate.push({
        name: inputFiles[f],
        content: fileContent
      })
      core.info(`Retrieved file to update: ${inputFiles[f]}`)
    } catch (error) {
      core.error(`Unable to retrieve input file: ${inputFiles[f]} \n ${error}`)
    }
  }
}

/**
 * Updates the contribRC with the new contributor by adding them
 * or updating the contributions of an existing record. Returns true
 * if an update needs to be made to the repo; false if not.
 * @param contributor Contributor to ensure is in the contribRC
 */
const updateRC = (): boolean => {
  let existingContributor = contribRC.contributors.find(
    f => f.login == contributor.login
  )

  // if the contributor exists, see if they have any new
  // contribution types.  If so, merge and update.
  if (existingContributor) {
    const newContributions = contributor.contributions.filter(f => {
      return existingContributor!.contributions.indexOf(f) < 0
    })

    core.info(
      `contributor.contributions: ${JSON.stringify(contributor.contributions)}`
    )
    core.info(
      `existingContributor.contributions: ${JSON.stringify(
        existingContributor.contributions
      )}`
    )
    core.info(`newContributions: ${JSON.stringify(newContributions)}`)

    // If there were no new contributions, we're done so return false.
    if (newContributions.length === 0) {
      core.info(`No new contributions identified for ${contributor.login}`)
      return false
    }

    core.info(
      `Identified new contributions for ${
        contributor.login
      }: ${newContributions.join(', ')}`
    )

    let filteredContributors = contribRC.contributors.filter(
      f => f.login != contributor.login
    )

    contributor.contributions = [
      ...existingContributor.contributions,
      ...newContributions
    ]
    filteredContributors.push(contributor)
    contribRC.contributors = filteredContributors
  } else {
    contribRC.contributors.push(contributor)
  }
  return true
}

/**
 * Iterate through each input file and update
 * contributor table and badge
 */
const processFiles = async () => {
  for (let i = 0; i < filesToUpdate.length; i++) {
    let fileToUpdate: IFile = filesToUpdate[i]

    const badgeStart: number = fileToUpdate.content.indexOf(markup_badge_start)
    const badgeEnd: number = fileToUpdate.content.indexOf(markup_badge_end)

    // Look through content for the badge markup and
    // if found, update
    const badgeMarkup: string = `${markup_badge_start}\n[![All Contributors](https://img.shields.io/badge/code_community-${contribRC.contributors.length}-orange.svg?style=flat-square)](#contributors)\n${markup_badge_end}`

    if (badgeStart === -1 && badgeEnd === -1) {
      fileToUpdate.content = `${badgeMarkup}\n${fileToUpdate.content}`
    } else if (badgeStart >= 0 && badgeEnd >= 0 && badgeEnd > badgeStart) {
      fileToUpdate.content = `${fileToUpdate.content.slice(
        0,
        badgeStart - 1
      )}\n${badgeMarkup}\n${fileToUpdate.content.slice(
        badgeEnd + markup_badge_end.length
      )}`
    }

    const tableStart: number = fileToUpdate.content.indexOf(markup_table_start)
    const tableEnd: number = fileToUpdate.content.indexOf(markup_table_end)

    let contributorContent = buildContributorContent()

    // Look through content for the table markup and
    // if found, update
    if (tableStart === -1 && tableEnd === -1) {
      fileToUpdate.content = `${fileToUpdate.content}\n${contributorContent}`
    } else if (tableStart >= 0 && tableEnd >= 0 && tableEnd > tableStart) {
      fileToUpdate.content = `${fileToUpdate.content.slice(
        0,
        tableStart - 1
      )}\n${contributorContent}\n${fileToUpdate.content.slice(
        tableEnd + markup_table_end.length
      )}`
    }
  }
}

let contributorTable: string = ''

const buildContributorContent = (): string => {
  contributorTable = '<table>\n'

  let currentContrib: number = 0

  while (currentContrib < contribRC.contributors.length) {
    currentContrib = buildContributorRow(currentContrib)
  }

  contributorTable = contributorTable + '</table>\n'
  return `${markup_table_start}\n${contributorTable}\n${markup_table_end}`
}

const buildContributorRow = (contrib: number): number => {
  let contribRow: string = '<tr>\n'

  let index: number = 0

  while (
    index < contributorsPerRow &&
    contrib < contribRC.contributors.length
  ) {
    const currentContrib: IContributor = contribRC.contributors[index]

    contribRow =
      contribRow +
      `<td align="center">
            <a href="https://github.com/${currentContrib.login}">
              <img src="${currentContrib.avatar_url}" width="100px;" alt=""/><br />
              <sub><b>${currentContrib.login}</b></sub></a><br />`

    for (let c: number = 0; c < currentContrib.contributions.length; c++) {
      contribRow =
        contribRow +
        addContribution(currentContrib, currentContrib.contributions[c])
    }

    contribRow = contribRow + '</td>'

    index++
    contrib++
  }

  contribRow = contribRow + '</tr>\n'
  contributorTable = contributorTable + contribRow

  return contrib
}

const addContribution = (
  contrib: IContributor,
  contribution: string
): string => {
  switch (contribution) {
    case 'bug':
      return `<a href="https://github.com/${owner}/${repo}/issues?q=author%3A${contrib.login}" title="Bug reports">🐛</a> `
    case 'enhancement':
      return `<a href="https://github.com/${owner}/${repo}/issues?q=author%3A${contrib.login}" title="Ideas, Planning, & Feedback">🤔</a> `
    case 'documentation':
      return `<a href="https://github.com/${owner}/${repo}/commits?author=${contrib.login}" title="Documentation">📖</a> `
    case 'code':
      return `<a href="https://github.com/${owner}/${repo}/commits?author=${contrib.login}" title="Code">💻</a> `
    case 'tests':
      return `<a href="https://github.com/${owner}/${repo}/commits?author=${contrib.login}" title="Tests">⚠️</a> `
    case 'content':
      return `<a href="#content-${contrib.login}" title="Content">🖋</a> `
    default:
      return ''
  }
}

/**
 * Commits all changes to repo
 */
const commitContribution = async () => {
  await getBaseBranch()
  await getLastCommitSha()

  let tree: Octokit.GitCreateTreeParamsTree[] = []

  for (let f = 0; f < filesToUpdate.length; f++) {
    tree.push({
      content: filesToUpdate[f].content,
      mode: '100644',
      path: filesToUpdate[f].name
    })
  }

  tree.push({
    content: JSON.stringify(contribRC),
    mode: '100644',
    path: '.code-communityrc'
  })

  let response = await octokit.git.createTree({
    owner,
    repo,
    base_tree: treeSha,
    tree
  })

  newTreeSha = response.data.sha

  await createCommit()
  await createRef()
  await createPullRequest()
}

/**
 * Retrieves the content for a file within the repo
 * @param path Path, including filename, relative to the root of the repo
 */
const getFile = async (
  path: string
): Promise<Octokit.Response<Octokit.ReposGetContentsResponse>> => {
  return await octokit.repos.getContents({
    owner,
    repo,
    path
  })
}

/**
 * Creates or updates a file within the repo
 * @param path Path, including filename, relative to the root of the repo
 * @param content Content of the file to save
 * @param message Commit message
 * @param branch Branch to commit changes to
 */
const createOrUpdateFile = async (
  path: string,
  content: string,
  message: string,
  branch: string
): Promise<Octokit.Response<Octokit.ReposCreateOrUpdateFileResponse>> => {
  return await octokit.repos.createOrUpdateFile({
    owner,
    repo,
    path,
    branch,
    message,
    content: btoa(content)
  })
}

const getBaseBranch = async (): Promise<void> => {
  let response = await octokit.repos.get({owner, repo})
  baseRef = response.data.default_branch
}

const getLastCommitSha = async (): Promise<void> => {
  let response = await octokit.repos.listCommits({
    owner,
    repo,
    sha: baseRef,
    per_page: 1
  })
  latestCommitSha = response.data[0].sha
  treeSha = response.data[0].commit.tree.sha
}

const createCommit = async (): Promise<void> => {
  let response = await octokit.git.createCommit({
    owner,
    repo,
    message: `Updating contributions for ${contributor.login}`,
    tree: newTreeSha,
    parents: [latestCommitSha]
  })
  latestCommitSha = response.data.sha
}

const createRef = async (): Promise<void> => {
  let response = await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${contribSha}`,
    sha: latestCommitSha
  })
}

const createPullRequest = async (): Promise<void> => {
  await octokit.pulls.create({
    owner,
    repo,
    title: `Updating contributions for ${contributor.login}`,
    body: `Updating contributions for ${contributor.login}`,
    head: contribSha,
    base: baseRef
  })
}
