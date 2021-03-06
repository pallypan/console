import * as _ from 'lodash-es';
import * as React from 'react';
import { Helmet } from 'react-helmet';
import { Base64 } from 'js-base64';
import { ActionGroup, Button } from '@patternfly/react-core';
import { MinusCircleIcon, PlusCircleIcon } from '@patternfly/react-icons';

import { k8sCreate, k8sUpdate, K8sResourceKind, referenceFor } from '../../module/k8s';
import {
  ButtonBar,
  Firehose,
  history,
  StatusBox,
  LoadingBox,
  Dropdown,
  resourceObjPath,
} from '../utils';
import { ModalBody, ModalTitle, ModalSubmitFooter } from '../factory/modal';
import { AsyncComponent } from '../utils/async';
import { SecretModel } from '../../models';
import { WebHookSecretKey } from '../secret';
/* eslint-disable import/named */
import { useTranslation, withTranslation, WithTranslation } from 'react-i18next';
import i18next, { TFunction } from 'i18next';

export enum SecretTypeAbstraction {
  generic = 'generic',
  source = 'source',
  image = 'image',
  webhook = 'webhook',
}

const secretDisplayType = (abstraction: SecretTypeAbstraction) => {
  switch (abstraction) {
    case 'generic':
      return i18next.t('secret~Key/value');
    case 'image':
      return i18next.t('secret~Image pull');
    default:
      return _.upperFirst(abstraction);
  }
};

const AUTHS_KEY = 'auths';

export enum SecretType {
  basicAuth = 'kubernetes.io/basic-auth',
  dockercfg = 'kubernetes.io/dockercfg',
  dockerconfigjson = 'kubernetes.io/dockerconfigjson',
  opaque = 'Opaque',
  serviceAccountToken = 'kubernetes.io/service-account-token',
  sshAuth = 'kubernetes.io/ssh-auth',
  tls = 'kubernetes.io/tls',
}

export type BasicAuthSubformState = {
  username: string;
  password: string;
};

const secretFormExplanation = {
  [SecretTypeAbstraction.generic]: i18next.t(
    'secret~Key/value Secrets let you inject sensitive data into your application as files or environment variables.',
  ),
  [SecretTypeAbstraction.source]: i18next.t(
    'secret~Source Secrets let you authenticate against a Git server.',
  ),
  [SecretTypeAbstraction.image]: i18next.t(
    'secret~Image pull Secrets let you authenticate against a private image registry.',
  ),
  [SecretTypeAbstraction.webhook]: i18next.t(
    'secret~Webhook Secrets let you authenticate a webhook trigger.',
  ),
};

const toDefaultSecretType = (typeAbstraction: SecretTypeAbstraction): SecretType => {
  switch (typeAbstraction) {
    case SecretTypeAbstraction.source:
      return SecretType.basicAuth;
    case SecretTypeAbstraction.image:
      return SecretType.dockerconfigjson;
    default:
      return SecretType.opaque;
  }
};

const toTypeAbstraction = (obj): SecretTypeAbstraction => {
  const { data, type } = obj;
  switch (type) {
    case SecretType.basicAuth:
    case SecretType.sshAuth:
      return SecretTypeAbstraction.source;
    case SecretType.dockerconfigjson:
    case SecretType.dockercfg:
      return SecretTypeAbstraction.image;
    default:
      if (data?.[WebHookSecretKey] && _.size(data) === 1) {
        return SecretTypeAbstraction.webhook;
      }
      return SecretTypeAbstraction.generic;
  }
};

const generateSecret = () => {
  // http://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript
  const s4 = () =>
    Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  return s4() + s4() + s4() + s4();
};

const determineSecretType = (stringData): SecretType => {
  const dataKeys = _.keys(stringData).sort();
  if (_.isEqual(dataKeys, ['tls.crt', 'tls.key'])) {
    return SecretType.tls;
  } else if (_.isEqual(dataKeys, ['ca.crt', 'namespace', 'service-ca.crt', 'token'])) {
    return SecretType.serviceAccountToken;
  } else if (_.isEqual(dataKeys, ['.dockercfg'])) {
    return SecretType.dockercfg;
  } else if (_.isEqual(dataKeys, ['.dockerconfigjson'])) {
    return SecretType.dockerconfigjson;
  } else if (_.isEqual(dataKeys, ['password', 'username'])) {
    return SecretType.basicAuth;
  } else if (_.isEqual(dataKeys, ['ssh-privatekey'])) {
    return SecretType.sshAuth;
  }
  return SecretType.opaque;
};

// withSecretForm returns SubForm which is a Higher Order Component for all the types of secret forms.
export const withSecretForm = (SubForm, modal?: boolean) =>
  withTranslation()(
    class SecretFormComponent extends React.Component<BaseEditSecretProps_, BaseEditSecretState_> {
      constructor(props) {
        super(props);
        const existingSecret = _.pick(props.obj, ['metadata', 'type']);
        const defaultSecretType = toDefaultSecretType(this.props.secretTypeAbstraction);
        const secret = _.defaultsDeep({}, props.fixed, existingSecret, {
          apiVersion: 'v1',
          data: {},
          kind: 'Secret',
          metadata: {
            name: '',
          },
          type: defaultSecretType,
        });

        this.state = {
          secretTypeAbstraction: this.props.secretTypeAbstraction,
          secret,
          inProgress: false,
          type: defaultSecretType,
          stringData: _.mapValues(_.get(props.obj, 'data'), (value) => {
            return value ? Base64.decode(value) : '';
          }),
          disableForm: false,
        };
        this.onDataChanged = this.onDataChanged.bind(this);
        this.onNameChanged = this.onNameChanged.bind(this);
        this.onError = this.onError.bind(this);
        this.onFormDisable = this.onFormDisable.bind(this);
        this.save = this.save.bind(this);
      }
      onDataChanged(secretsData) {
        this.setState({
          stringData: { ...secretsData.stringData },
        });
      }
      onError(err) {
        this.setState({
          error: err,
          inProgress: false,
        });
      }
      onNameChanged(event) {
        const name = event.target.value;
        this.setState((state: BaseEditSecretState_) => {
          const secret = _.cloneDeep(state.secret);
          secret.metadata.name = name;
          return { secret };
        });
      }
      onFormDisable(disable) {
        this.setState({
          disableForm: disable,
        });
      }
      save(e) {
        e.preventDefault();
        const { metadata } = this.state.secret;
        this.setState({ inProgress: true });
        const newSecret = _.assign(
          {},
          this.state.secret,
          { stringData: this.state.stringData },
          // When creating new Secret, determine it's type from the `stringData` keys.
          // When updating a Secret, use it's type.
          this.props.isCreate ? { type: determineSecretType(this.state.stringData) } : {},
        );
        (this.props.isCreate
          ? k8sCreate(SecretModel, newSecret)
          : k8sUpdate(SecretModel, newSecret, metadata.namespace, newSecret.metadata.name)
        ).then(
          (secret) => {
            this.setState({ inProgress: false });
            if (this.props.onSave) {
              this.props.onSave(secret.metadata.name);
            }
            if (!modal) {
              history.push(resourceObjPath(secret, referenceFor(secret)));
            }
          },
          (err) => this.setState({ error: err.message, inProgress: false }),
        );
      }

      renderBody = () => {
        const { t } = this.props;
        return (
          <>
            <fieldset disabled={!this.props.isCreate}>
              <div className="form-group">
                <label className="control-label co-required" htmlFor="secret-name">
                  {t('secret~Secret name')}
                </label>
                <div>
                  <input
                    className="pf-c-form-control"
                    type="text"
                    onChange={this.onNameChanged}
                    value={this.state.secret.metadata.name}
                    aria-describedby="secret-name-help"
                    id="secret-name"
                    required
                  />
                  <p className="help-block" id="secret-name-help">
                    {t('secret~Unique name of the new Secret.')}
                  </p>
                </div>
              </div>
            </fieldset>
            <SubForm
              onChange={this.onDataChanged}
              onError={this.onError}
              onFormDisable={this.onFormDisable}
              stringData={this.state.stringData}
              secretType={this.state.secret.type}
              isCreate={this.props.isCreate}
            />
          </>
        );
      };

      render() {
        const { secretTypeAbstraction } = this.state;
        const { onCancel = history.goBack } = this.props;
        const { t } = this.props;
        const title = t('secret~{{verb}} {{type}} Secret', {
          verb: this.props.titleVerb,
          type: secretDisplayType(secretTypeAbstraction),
        });
        return modal ? (
          <form className="co-create-secret-form modal-content" onSubmit={this.save}>
            <ModalTitle>{title}</ModalTitle>
            <ModalBody>{this.renderBody()}</ModalBody>
            <ModalSubmitFooter
              errorMessage={this.state.error || ''}
              inProgress={this.state.inProgress}
              submitText={t('secret~Create')}
              cancel={this.props.onCancel}
            />
          </form>
        ) : (
          <div className="co-m-pane__body">
            <Helmet>
              <title>{title}</title>
            </Helmet>
            <form
              className="co-m-pane__body-group co-create-secret-form co-m-pane__form"
              onSubmit={this.save}
            >
              <h1 className="co-m-pane__heading">{title}</h1>
              <p className="co-m-pane__explanation">{this.props.explanation}</p>
              {this.renderBody()}
              <ButtonBar errorMessage={this.state.error} inProgress={this.state.inProgress}>
                <ActionGroup className="pf-c-form">
                  <Button
                    type="submit"
                    data-test="save-changes"
                    isDisabled={this.state.disableForm}
                    variant="primary"
                    id="save-changes"
                  >
                    {this.props.saveButtonText || t('secret~Create')}
                  </Button>
                  <Button type="button" variant="secondary" id="cancel" onClick={onCancel}>
                    {t('secret~Cancel')}
                  </Button>
                </ActionGroup>
              </ButtonBar>
            </form>
          </div>
        );
      }
    },
  );

const getImageSecretKey = (secretType: SecretType): string => {
  switch (secretType) {
    case SecretType.dockercfg:
      return '.dockercfg';
    case SecretType.dockerconfigjson:
      return '.dockerconfigjson';
    default:
      return secretType;
  }
};

class ImageSecretFormWithTrans extends React.Component<
  ImageSecretFormProps & WithTranslation,
  ImageSecretFormState
> {
  constructor(props) {
    super(props);
    const data = this.props.isCreate ? { '.dockerconfigjson': '{}' } : this.props.stringData;
    let parsedData;
    const { t } = props;
    try {
      parsedData = _.mapValues(data, JSON.parse);
    } catch (err) {
      this.props.onError(t("secret~Error parsing Secret's data: {{message}}", err));
      parsedData = { '.dockerconfigjson': {} };
    }
    this.state = {
      type: this.props.secretType,
      dataKey: getImageSecretKey(this.props.secretType),
      stringData: parsedData,
      authType: 'credentials',
    };
    this.onDataChanged = this.onDataChanged.bind(this);
    this.changeFormType = this.changeFormType.bind(this);
    this.onFormDisable = this.onFormDisable.bind(this);
  }
  onDataChanged(secretData) {
    const dataKey = secretData[AUTHS_KEY] ? '.dockerconfigjson' : '.dockercfg';
    this.setState(
      {
        stringData: { [dataKey]: secretData },
      },
      () =>
        this.props.onChange({
          stringData: _.mapValues(this.state.stringData, JSON.stringify),
        }),
    );
  }
  changeFormType(authType) {
    this.setState({
      authType,
    });
  }
  onFormDisable(disable) {
    this.props.onFormDisable(disable);
  }
  render() {
    const { t } = this.props;
    const authTypes = {
      credentials: t('secret~Image registry credentials'),
      'config-file': t('secret~Upload configuration file'),
    };
    const data = _.get(this.state.stringData, this.state.dataKey);
    return (
      <>
        {this.props.isCreate && (
          <div className="form-group">
            <label className="control-label" htmlFor="secret-type">
              {t('secret~Authentication type')}
            </label>
            <div className="co-create-secret__dropdown">
              <Dropdown
                items={authTypes}
                dropDownClassName="dropdown--full-width"
                id="dropdown-selectbox"
                selectedKey={this.state.authType}
                onChange={this.changeFormType}
              />
            </div>
          </div>
        )}
        {this.state.authType === 'credentials' ? (
          <CreateConfigSubform onChange={this.onDataChanged} stringData={data} />
        ) : (
          <UploadConfigSubform
            onChange={this.onDataChanged}
            stringData={data}
            onDisable={this.onFormDisable}
          />
        )}
      </>
    );
  }
}
export const ImageSecretForm = withTranslation()(ImageSecretFormWithTrans);

type ConfigEntryFormState = {
  address: string;
  username: string;
  password: string;
  email: string;
  auth: string;
  uid: string;
};

type ConfigEntryFormProps = {
  id: number;
  entry: Object;
  onChange: Function;
};

class ConfigEntryFormWithTrans extends React.Component<
  ConfigEntryFormProps & WithTranslation,
  ConfigEntryFormState
> {
  constructor(props: ConfigEntryFormProps & WithTranslation) {
    super(props);
    this.state = {
      address: _.get(this.props.entry, 'address'),
      username: _.get(this.props.entry, 'username'),
      password: _.get(this.props.entry, 'password'),
      email: _.get(this.props.entry, 'email'),
      auth: _.get(this.props.entry, 'auth'),
      uid: _.get(this.props, 'uid'),
    };
  }

  propagateChange = () => {
    const { onChange, id } = this.props;
    onChange(this.state, id);
  };

  onAddressChanged: React.ReactEventHandler<HTMLInputElement> = (event) => {
    this.setState({ address: event.currentTarget.value }, this.propagateChange);
  };

  onUsernameChanged: React.ReactEventHandler<HTMLInputElement> = (event) => {
    const username = event.currentTarget.value;
    this.setState(
      (state: ConfigEntryFormState) => ({
        username,
        auth: Base64.encode(`${username}:${state.password}`),
      }),
      this.propagateChange,
    );
  };

  onPasswordChanged: React.ReactEventHandler<HTMLInputElement> = (event) => {
    const password = event.currentTarget.value;
    this.setState(
      (state: ConfigEntryFormState) => ({
        password,
        auth: Base64.encode(`${state.username}:${password}`),
      }),
      this.propagateChange,
    );
  };

  onEmailChanged: React.ReactEventHandler<HTMLInputElement> = (event) => {
    this.setState({ email: event.currentTarget.value }, this.propagateChange);
  };

  render() {
    const { t } = this.props;
    return (
      <div className="co-m-pane__body-group" data-test-id="create-image-secret-form">
        <div className="form-group">
          <label className="control-label co-required" htmlFor={`${this.props.id}-address`}>
            {t('secret~Registry server address')}
          </label>
          <div>
            <input
              className="pf-c-form-control"
              id={`${this.props.id}-address`}
              type="text"
              name="address"
              onChange={this.onAddressChanged}
              value={this.state.address}
              required
            />
          </div>
        </div>
        <div className="form-group">
          <label className="control-label co-required" htmlFor={`${this.props.id}-username`}>
            {t('secret~Username')}
          </label>
          <div>
            <input
              className="pf-c-form-control"
              id={`${this.props.id}-username`}
              type="text"
              name="username"
              onChange={this.onUsernameChanged}
              value={this.state.username}
              required
            />
          </div>
        </div>
        <div className="form-group">
          <label className="control-label co-required" htmlFor={`${this.props.id}-password`}>
            {t('secret~Password')}
          </label>
          <div>
            <input
              className="pf-c-form-control"
              id={`${this.props.id}-password`}
              type="password"
              name="password"
              onChange={this.onPasswordChanged}
              value={this.state.password}
              required
            />
          </div>
        </div>
        <div className="form-group">
          <label className="control-label" htmlFor={`${this.props.id}-email`}>
            {t('secret~Email')}
          </label>
          <div>
            <input
              className="pf-c-form-control"
              id={`${this.props.id}-email`}
              type="text"
              name="email"
              onChange={this.onEmailChanged}
              value={this.state.email}
            />
          </div>
        </div>
      </div>
    );
  }
}
const ConfigEntryForm = withTranslation()(ConfigEntryFormWithTrans);

type CreateConfigSubformState = {
  isDockerconfigjson: boolean;
  hasDuplicate: boolean;
  secretEntriesArray: {
    entry: {
      address: string;
      username: string;
      password: string;
      email: string;
      auth: string;
    };
    uid: string;
  }[];
};

class CreateConfigSubformWithTrans extends React.Component<
  CreateConfigSubformProps & WithTranslation,
  CreateConfigSubformState
> {
  constructor(props: CreateConfigSubformProps & WithTranslation) {
    super(props);
    this.state = {
      // If user creates a new image secret by filling out the form a 'kubernetes.io/dockerconfigjson' secret will be created.
      isDockerconfigjson: _.isEmpty(this.props.stringData) || !!this.props.stringData[AUTHS_KEY],
      secretEntriesArray: this.imageSecretObjectToArray(
        this.props.stringData[AUTHS_KEY] || this.props.stringData,
      ),
      hasDuplicate: false,
    };
    this.onDataChanged = this.onDataChanged.bind(this);
  }
  newImageSecretEntry() {
    return {
      entry: {
        address: '',
        username: '',
        password: '',
        email: '',
        auth: '',
      },
      uid: _.uniqueId(),
    };
  }
  imageSecretObjectToArray(imageSecretObject) {
    const imageSecretArray = [];
    if (_.isEmpty(imageSecretObject)) {
      return _.concat(imageSecretArray, this.newImageSecretEntry());
    }
    _.each(imageSecretObject, (v, k) => {
      // Decode and parse 'auth' in case 'username' and 'password' are not part of the secret.
      const decodedAuth = Base64.decode(_.get(v, 'auth', ''));
      const parsedAuth = _.isEmpty(decodedAuth) ? _.fill(Array(2), '') : _.split(decodedAuth, ':');
      imageSecretArray.push({
        entry: {
          address: k,
          username: _.get(v, 'username', parsedAuth[0]),
          password: _.get(v, 'password', parsedAuth[1]),
          email: _.get(v, 'email', ''),
          auth: _.get(v, 'auth', ''),
        },
        uid: _.get(v, 'uid', _.uniqueId()),
      });
    });
    return imageSecretArray;
  }
  imageSecretArrayToObject(imageSecretArray) {
    const imageSecretsObject = {};
    _.each(imageSecretArray, (value) => {
      imageSecretsObject[value.entry.address] = _.pick(value.entry, [
        'username',
        'password',
        'auth',
        'email',
      ]);
    });
    return imageSecretsObject;
  }
  propagateEntryChange(secretEntriesArray) {
    const imageSecretObject = this.imageSecretArrayToObject(secretEntriesArray);
    this.props.onChange(
      this.state.isDockerconfigjson ? { [AUTHS_KEY]: imageSecretObject } : imageSecretObject,
    );
  }
  onDataChanged(updatedEntry, entryIndex: number) {
    this.setState(
      (state: CreateConfigSubformState) => {
        const secretEntriesArray = [...state.secretEntriesArray];
        const updatedEntryData = {
          uid: secretEntriesArray[entryIndex].uid,
          entry: updatedEntry,
        };
        secretEntriesArray[entryIndex] = updatedEntryData;
        return {
          secretEntriesArray,
        };
      },
      () => this.propagateEntryChange(this.state.secretEntriesArray),
    );
  }
  removeEntry(entryIndex: number) {
    this.setState(
      (state: CreateConfigSubformState) => {
        const secretEntriesArray = [...state.secretEntriesArray];
        secretEntriesArray.splice(entryIndex, 1);
        return { secretEntriesArray };
      },
      () => this.propagateEntryChange(this.state.secretEntriesArray),
    );
  }
  addEntry() {
    this.setState(
      {
        secretEntriesArray: _.concat(this.state.secretEntriesArray, this.newImageSecretEntry()),
      },
      () => {
        this.propagateEntryChange(this.state.secretEntriesArray);
      },
    );
  }
  render() {
    const { t } = this.props;
    const secretEntriesList = _.map(this.state.secretEntriesArray, (entryData, index) => {
      return (
        <div className="co-add-remove-form__entry" key={entryData.uid}>
          {_.size(this.state.secretEntriesArray) > 1 && (
            <div className="co-add-remove-form__link--remove-entry">
              <Button onClick={() => this.removeEntry(index)} type="button" variant="link">
                <MinusCircleIcon className="co-icon-space-r" />
                {t('secret~Remove credentials')}
              </Button>
            </div>
          )}
          <ConfigEntryForm id={index} entry={entryData.entry} onChange={this.onDataChanged} />
        </div>
      );
    });
    return (
      <>
        {secretEntriesList}
        <Button
          className="co-create-secret-form__link--add-entry pf-m-link--align-left"
          onClick={() => this.addEntry()}
          type="button"
          variant="link"
        >
          <PlusCircleIcon className="co-icon-space-r" />
          {t('secret~Add credentials')}
        </Button>
      </>
    );
  }
}
export const CreateConfigSubform = withTranslation()(CreateConfigSubformWithTrans);

class UploadConfigSubformWithTrans extends React.Component<
  UploadConfigSubformProps,
  UploadConfigSubformState
> {
  constructor(props) {
    super(props);
    this.state = {
      configFile: _.isEmpty(this.props.stringData) ? '' : JSON.stringify(this.props.stringData),
      parseError: false,
    };
    this.changeData = this.changeData.bind(this);
    this.onFileChange = this.onFileChange.bind(this);
  }
  changeData(event) {
    this.updateState(_.attempt(JSON.parse, event.target.value), event.target.value);
  }
  onFileChange(fileData) {
    this.updateState(_.attempt(JSON.parse, fileData), fileData);
  }
  updateState(parsedData, stringData) {
    this.setState(
      {
        configFile: stringData,
        parseError: _.isError(parsedData),
      },
      () => {
        this.props.onChange(parsedData);
        this.props.onDisable(this.state.parseError);
      },
    );
  }
  render() {
    const { t } = this.props;
    return (
      <>
        <DroppableFileInput
          onChange={this.onFileChange}
          inputFileData={this.state.configFile}
          id="docker-config"
          label={t('secret~Configuration file')}
          inputFieldHelpText={t('secret~Upload a .dockercfg or .docker/config.json file.')}
          textareaFieldHelpText={t(
            'secret~File with credentials and other configuration for connecting to a secured image registry.',
          )}
          isRequired={true}
        />
        {this.state.parseError && (
          <div className="co-create-secret-warning">
            {t('secret~Configuration file should be in JSON format.')}
          </div>
        )}
      </>
    );
  }
}
const UploadConfigSubform = withTranslation()(UploadConfigSubformWithTrans);

class WebHookSecretFormWithTrans extends React.Component<
  WebHookSecretFormProps,
  WebHookSecretFormState
> {
  constructor(props) {
    super(props);
    this.state = {
      stringData: { WebHookSecretKey: this.props.stringData.WebHookSecretKey || '' },
    };
    this.changeWebHookSecretkey = this.changeWebHookSecretkey.bind(this);
    this.generateWebHookSecret = this.generateWebHookSecret.bind(this);
  }
  changeWebHookSecretkey(event) {
    this.setState(
      {
        stringData: { WebHookSecretKey: event.target.value },
      },
      () => this.props.onChange(this.state),
    );
  }
  generateWebHookSecret() {
    this.setState(
      {
        stringData: { WebHookSecretKey: generateSecret() },
      },
      () => this.props.onChange(this.state),
    );
  }
  render() {
    const { t } = this.props;
    return (
      <div className="form-group">
        <label className="control-label co-required" htmlFor="webhook-secret-key">
          {t('secret~Webhook Secret key')}
        </label>
        <div className="pf-c-input-group">
          <input
            className="pf-c-form-control"
            id="webhook-secret-key"
            type="text"
            name="webhookSecretKey"
            onChange={this.changeWebHookSecretkey}
            value={this.state.stringData.WebHookSecretKey}
            aria-describedby="webhook-secret-help"
            required
          />
          <button
            type="button"
            onClick={this.generateWebHookSecret}
            className="pf-c-button pf-m-tertiary"
          >
            {t('secret~Generate')}
          </button>
        </div>
        <p className="help-block" id="webhook-secret-help">
          {t('secret~Value of the Secret will be supplied when invoking the webhook.')}
        </p>
      </div>
    );
  }
}
const WebHookSecretForm = withTranslation()(WebHookSecretFormWithTrans);

class SourceSecretFormWithTrans extends React.Component<
  SourceSecretFormProps,
  SourceSecretFormState
> {
  constructor(props) {
    super(props);
    this.state = {
      type: this.props.secretType,
      stringData: this.props.stringData || {},
      authType: SecretType.basicAuth,
    };
    this.changeAuthenticationType = this.changeAuthenticationType.bind(this);
    this.onDataChanged = this.onDataChanged.bind(this);
  }
  changeAuthenticationType(type: SecretType) {
    this.setState(
      {
        type,
      },
      () => this.props.onChange(this.state),
    );
  }
  onDataChanged(secretsData) {
    this.setState(
      {
        stringData: { ...secretsData },
      },
      () => this.props.onChange(this.state),
    );
  }
  render() {
    const { t } = this.props;
    const authTypes = {
      [SecretType.basicAuth]: t('secret~Basic authentication'),
      [SecretType.sshAuth]: t('secret~SSH key'),
    };
    return (
      <>
        {this.props.isCreate ? (
          <div className="form-group">
            <label className="control-label" htmlFor="secret-type">
              {t('secret~Authentication type')}
            </label>
            <div className="co-create-secret__dropdown">
              <Dropdown
                items={authTypes}
                dropDownClassName="dropdown--full-width"
                id="dropdown-selectbox"
                selectedKey={this.state.authType}
                onChange={this.changeAuthenticationType}
              />
            </div>
          </div>
        ) : null}
        {this.state.type === SecretType.basicAuth ? (
          <BasicAuthSubform onChange={this.onDataChanged} stringData={this.state.stringData} />
        ) : (
          <SSHAuthSubform onChange={this.onDataChanged} stringData={this.state.stringData} />
        )}
      </>
    );
  }
}
export const SourceSecretForm = withTranslation()(SourceSecretFormWithTrans);

class BasicAuthSubformWithTrans extends React.Component<
  BasicAuthSubformProps,
  BasicAuthSubformState
> {
  constructor(props) {
    super(props);
    this.state = {
      username: this.props.stringData.username || '',
      password: this.props.stringData.password || '',
    };
    this.changeData = this.changeData.bind(this);
  }
  changeData(event) {
    this.setState(
      {
        [event.target.name]: event.target.value,
      } as BasicAuthSubformState,
      () => this.props.onChange(this.state),
    );
  }
  render() {
    const { t } = this.props;
    return (
      <>
        <div className="form-group">
          <label className="control-label" htmlFor="username">
            {t('secret~Username')}
          </label>
          <div>
            <input
              className="pf-c-form-control"
              id="username"
              aria-describedby="username-help"
              type="text"
              name="username"
              onChange={this.changeData}
              value={this.state.username}
            />
            <p className="help-block" id="username-help">
              {t('secret~Optional username for Git authentication.')}
            </p>
          </div>
        </div>
        <div className="form-group">
          <label className="control-label co-required" htmlFor="password">
            {t('secret~Password or token')}
          </label>
          <div>
            <input
              className="pf-c-form-control"
              id="password"
              aria-describedby="password-help"
              type="password"
              name="password"
              onChange={this.changeData}
              value={this.state.password}
              required
            />
            <p className="help-block" id="password-help">
              {t(
                'secret~Password or token for Git authentication. Required if a ca.crt or .gitconfig file is not specified.',
              )}
            </p>
          </div>
        </div>
      </>
    );
  }
}
export const BasicAuthSubform = withTranslation()(BasicAuthSubformWithTrans);

const DroppableFileInput = (props) => (
  <AsyncComponent
    loader={() => import('../utils/file-input').then((c) => c.DroppableFileInput)}
    {...props}
  />
);

class SSHAuthSubformWithTrans extends React.Component<SSHAuthSubformProps, SSHAuthSubformState> {
  constructor(props) {
    super(props);
    this.state = {
      'ssh-privatekey': this.props.stringData['ssh-privatekey'] || '',
    };
    this.changeData = this.changeData.bind(this);
    this.onFileChange = this.onFileChange.bind(this);
  }
  changeData(event) {
    this.setState(
      {
        'ssh-privatekey': event.target.value.endsWith('\n')
          ? event.target.value
          : `${event.target.value}\n`,
      },
      () => this.props.onChange(this.state),
    );
  }
  onFileChange(fileData) {
    this.setState(
      {
        'ssh-privatekey': fileData.endsWith('\n') ? fileData : `${fileData}\n`,
      },
      () => this.props.onChange(this.state),
    );
  }
  render() {
    const { t } = this.props;
    return (
      <DroppableFileInput
        onChange={this.onFileChange}
        inputFileData={this.state['ssh-privatekey']}
        id="ssh-privatekey"
        label={t('secret~SSH private key')}
        inputFieldHelpText={t(
          'secret~Drag and drop file with your private SSH key here or browse to upload it.',
        )}
        textareaFieldHelpText={t('secret~Private SSH key file for Git authentication.')}
        isRequired={true}
      />
    );
  }
}
export const SSHAuthSubform = withTranslation()(SSHAuthSubformWithTrans);

type KeyValueEntryFormState = {
  key: string;
  value: string;
};

type KeyValueEntryFormProps = {
  entry: KeyValueEntryFormState;
  id: number;
  onChange: Function;
  t: TFunction;
};

type GenericSecretFormProps = {
  onChange: Function;
  stringData: {
    [key: string]: string;
  };
  isCreate: boolean;
  t: TFunction;
};

type GenericSecretFormState = {
  secretEntriesArray: {
    entry: KeyValueEntryFormState;
    uid: string;
  }[];
};

class GenericSecretFormWithTrans extends React.Component<
  GenericSecretFormProps,
  GenericSecretFormState
> {
  constructor(props) {
    super(props);
    this.state = {
      secretEntriesArray: this.genericSecretObjectToArray(this.props.stringData),
    };
    this.onDataChanged = this.onDataChanged.bind(this);
  }
  newGenericSecretEntry() {
    return {
      entry: {
        key: '',
        value: '',
      },
      uid: _.uniqueId(),
    };
  }
  genericSecretObjectToArray(genericSecretObject) {
    if (_.isEmpty(genericSecretObject)) {
      return [this.newGenericSecretEntry()];
    }
    return _.map(genericSecretObject, (value, key) => ({
      uid: _.uniqueId(),
      entry: {
        key,
        value,
      },
    }));
  }
  genericSecretArrayToObject(genericSecretArray) {
    return _.reduce(
      genericSecretArray,
      (acc, k) => _.assign(acc, { [k.entry.key]: k.entry.value }),
      {},
    );
  }
  onDataChanged(updatedEntry, entryID) {
    const updatedSecretEntriesArray = [...this.state.secretEntriesArray];
    const updatedEntryData = {
      uid: updatedSecretEntriesArray[entryID].uid,
      entry: updatedEntry,
    };
    updatedSecretEntriesArray[entryID] = updatedEntryData;
    this.setState(
      {
        secretEntriesArray: updatedSecretEntriesArray,
      },
      () =>
        this.props.onChange({
          stringData: this.genericSecretArrayToObject(this.state.secretEntriesArray),
        }),
    );
  }
  removeEntry(entryID) {
    const updatedSecretEntriesArray = [...this.state.secretEntriesArray];
    updatedSecretEntriesArray.splice(entryID, 1);
    this.setState(
      {
        secretEntriesArray: updatedSecretEntriesArray,
      },
      () =>
        this.props.onChange({
          stringData: this.genericSecretArrayToObject(this.state.secretEntriesArray),
        }),
    );
  }
  addEntry() {
    this.setState(
      {
        secretEntriesArray: _.concat(this.state.secretEntriesArray, this.newGenericSecretEntry()),
      },
      () =>
        this.props.onChange({
          stringData: this.genericSecretArrayToObject(this.state.secretEntriesArray),
        }),
    );
  }
  render() {
    const { t } = this.props;
    const secretEntriesList = _.map(this.state.secretEntriesArray, (entryData, index) => {
      return (
        <div className="co-add-remove-form__entry" key={entryData.uid}>
          {_.size(this.state.secretEntriesArray) > 1 && (
            <div className="co-add-remove-form__link--remove-entry">
              <Button type="button" onClick={() => this.removeEntry(index)} variant="link">
                <MinusCircleIcon className="co-icon-space-r" />
                {t('secret~Remove key/value')}
              </Button>
            </div>
          )}
          <KeyValueEntryForm
            id={index}
            entry={entryData.entry}
            onChange={this.onDataChanged}
            t={this.props.t}
          />
        </div>
      );
    });
    return (
      <>
        {secretEntriesList}
        <Button
          className="co-create-secret-form__link--add-entry pf-m-link--align-left"
          onClick={() => this.addEntry()}
          type="button"
          variant="link"
        >
          <PlusCircleIcon className="co-icon-space-r" />
          {t('secret~Add key/value')}
        </Button>
      </>
    );
  }
}
const GenericSecretForm = withTranslation()(GenericSecretFormWithTrans);

class KeyValueEntryForm extends React.Component<KeyValueEntryFormProps, KeyValueEntryFormState> {
  constructor(props) {
    super(props);
    this.state = {
      key: props.entry.key,
      value: props.entry.value,
    };
    this.onValueChange = this.onValueChange.bind(this);
    this.onKeyChange = this.onKeyChange.bind(this);
  }
  onValueChange(fileData) {
    this.setState(
      {
        value: fileData,
      },
      () => this.props.onChange(this.state, this.props.id),
    );
  }
  onKeyChange(event) {
    this.setState(
      {
        key: event.target.value,
      },
      () => this.props.onChange(this.state, this.props.id),
    );
  }
  render() {
    const { t } = this.props;
    return (
      <div className="co-create-generic-secret__form">
        <div className="form-group">
          <label className="control-label co-required" htmlFor={`${this.props.id}-key`}>
            {t('secret~Key')}
          </label>
          <div>
            <input
              className="pf-c-form-control"
              id={`${this.props.id}-key`}
              type="text"
              name="key"
              onChange={this.onKeyChange}
              value={this.state.key}
              required
            />
          </div>
        </div>
        <div className="form-group">
          <div>
            <DroppableFileInput
              onChange={this.onValueChange}
              inputFileData={this.state.value}
              id={`${this.props.id}-value`}
              label="Value"
              inputFieldHelpText={t(
                'secret~Drag and drop file with your value here or browse to upload it.',
              )}
            />
          </div>
        </div>
      </div>
    );
  }
}

const secretFormFactory = (secretType: SecretTypeAbstraction) => {
  switch (secretType) {
    case SecretTypeAbstraction.source:
      return withSecretForm(SourceSecretForm);
    case SecretTypeAbstraction.image:
      return withSecretForm(ImageSecretForm);
    case SecretTypeAbstraction.webhook:
      return withSecretForm(WebHookSecretForm);
    default:
      return withSecretForm(GenericSecretForm);
  }
};

class SecretLoadingWrapper extends React.Component<
  SecretLoadingWrapperProps,
  SecretLoadingWrapperState
> {
  readonly state: SecretLoadingWrapperState = {
    formComponent: null,
    secretTypeAbstraction: SecretTypeAbstraction.generic,
  };
  componentDidUpdate() {
    // Set the proper secret form component, once the secret is received by Firehose.
    // 'formComponent' needs to be set only once, to avoid losing form state,
    // caused by component mounting/unmounting.
    if (!this.state.formComponent && !_.isEmpty(this.props.obj.data)) {
      const secretTypeAbstraction = toTypeAbstraction(this.props.obj.data);
      this.setState({
        formComponent: secretFormFactory(secretTypeAbstraction),
        secretTypeAbstraction,
      });
    }
  }
  render() {
    const { obj, fixedKeys } = this.props;
    const { secretTypeAbstraction } = this.state;
    if (!this.state.formComponent) {
      return <LoadingBox />;
    }
    const SecretFormComponent = this.state.formComponent;
    const fixed = _.reduce(fixedKeys, (acc, k) => ({ ...acc, k: _.get(obj.data, k) }), {});
    return (
      <StatusBox {...obj}>
        <SecretFormComponent
          {...this.props}
          secretTypeAbstraction={secretTypeAbstraction}
          obj={obj.data}
          fixed={fixed}
          explanation={secretFormExplanation[secretTypeAbstraction]}
        />
      </StatusBox>
    );
  }
}

class CreateSecretWithTrans extends React.Component<
  CreateSecretProps & WithTranslation,
  CreateSecretState
> {
  readonly state: CreateSecretState = {
    formComponent: secretFormFactory(this.props.match.params.type),
    secretTypeAbstraction: this.props.match.params.type,
  };
  render() {
    const { secretTypeAbstraction, formComponent } = this.state;
    const { params } = this.props.match;
    const SecretFormComponent = formComponent;
    const { t } = this.props;
    return (
      <SecretFormComponent
        fixed={{ metadata: { namespace: params.ns } }}
        secretTypeAbstraction={secretTypeAbstraction}
        explanation={secretFormExplanation[params.type]}
        titleVerb={t('secret~Create')}
        isCreate={true}
      />
    );
  }
}
export const CreateSecret = withTranslation()(CreateSecretWithTrans);

type CreateSecretProps = {
  match: {
    params: {
      type: SecretTypeAbstraction;
      ns: string;
    };
  };
  t: TFunction;
};

type CreateSecretState = {
  formComponent: React.ReactType;
  secretTypeAbstraction: SecretTypeAbstraction;
};

export const EditSecret = ({ match: { params }, kind }) => {
  const { t } = useTranslation();
  return (
    <Firehose
      resources={[{ kind, name: params.name, namespace: params.ns, isList: false, prop: 'obj' }]}
    >
      <SecretLoadingWrapper
        fixedKeys={['kind', 'metadata']}
        titleVerb={t('secret~Edit')}
        saveButtonText={t('secret~Save')}
      />
    </Firehose>
  );
};

type SecretLoadingWrapperProps = {
  obj?: {
    data?: K8sResourceKind;
    [key: string]: any;
  };
  fixedKeys: string[];
  titleVerb: string;
  saveButtonText: string;
};

type SecretLoadingWrapperState = {
  formComponent: React.ReactType;
  secretTypeAbstraction: SecretTypeAbstraction;
};

type BaseEditSecretState_ = {
  secretTypeAbstraction?: SecretTypeAbstraction;
  secret: K8sResourceKind;
  inProgress: boolean;
  type: SecretType;
  stringData: {
    [key: string]: string;
  };
  error?: any;
  disableForm: boolean;
};

type BaseEditSecretProps_ = {
  obj?: K8sResourceKind;
  fixed: any;
  kind?: string;
  isCreate: boolean;
  titleVerb: string;
  secretTypeAbstraction?: SecretTypeAbstraction;
  saveButtonText?: string;
  explanation?: string;
  onCancel?: () => void;
  onSave?: (name: string) => void;
  t: TFunction;
};

type BasicAuthSubformProps = {
  onChange: Function;
  stringData: {
    [key: string]: string;
  };
  t: TFunction;
};

type ImageSecretFormState = {
  type: SecretType;
  stringData: {
    [key: string]: any;
  };
  authType: string;
  dataKey: string;
};

type ImageSecretFormProps = {
  onChange: Function;
  onError: Function;
  onFormDisable: Function;
  stringData: {
    [key: string]: string;
  };
  secretType: SecretType;
  isCreate: boolean;
};

type CreateConfigSubformProps = {
  onChange: Function;
  stringData: {
    [key: string]: any;
  };
};

type UploadConfigSubformState = {
  parseError: boolean;
  configFile: string;
};

type UploadConfigSubformProps = {
  onChange: Function;
  onDisable: Function;
  stringData: {
    [key: string]: Object;
  };
  t: TFunction;
};

type SSHAuthSubformState = {
  'ssh-privatekey': string;
};

type SSHAuthSubformProps = {
  onChange: Function;
  stringData: {
    [key: string]: string;
  };
  t: TFunction;
};

type SourceSecretFormState = {
  type: SecretType;
  stringData: {
    [key: string]: string;
  };
  authType: SecretType.basicAuth | SecretType.sshAuth;
};

type SourceSecretFormProps = {
  onChange: Function;
  stringData: {
    [key: string]: string;
  };
  secretType: SecretType;
  isCreate: boolean;
  t: TFunction;
};

type WebHookSecretFormState = {
  stringData: {
    [key: string]: string;
  };
};

type WebHookSecretFormProps = {
  onChange: Function;
  stringData: {
    WebHookSecretKey: string;
  };
  t: TFunction;
};
