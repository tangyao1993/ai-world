import React, { ChangeEvent, PureComponent } from "react";
import Popup from "./common/Popup";
import Button from "./common/Button";
import { NpcCreateRequest, NpcGender } from "../types/Npc";

interface Props {
  isVisible: boolean;
  onClose: () => void;
  onCreate: (request: NpcCreateRequest) => void;
}

interface State {
  name: string;
  gender: NpcGender;
  soul: string;
  tagsInput: string;
  errorMessage: string;
}

const MAX_NPC_NAME_LENGTH = 32;
const MAX_SOUL_LENGTH = 300;
const MAX_PERSONA_TAGS = 10;
const MAX_PERSONA_TAG_LENGTH = 24;

function normalizeNpcSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.slice(0, 24) || "custom";
}

function buildNpcId(name: string): string {
  return `npc-${normalizeNpcSlug(name)}-${Date.now().toString(36).slice(-6)}`;
}

function parsePersonaTags(tagsInput: string): string[] {
  const tags = tagsInput
    .split(",")
    .map((tag) => tag.trim().slice(0, MAX_PERSONA_TAG_LENGTH))
    .filter((tag) => !!tag);

  const dedupe = new Set<string>();
  const normalizedTags: string[] = [];

  for (const tag of tags) {
    if (dedupe.has(tag)) continue;
    dedupe.add(tag);
    normalizedTags.push(tag);
    if (normalizedTags.length >= MAX_PERSONA_TAGS) break;
  }

  return normalizedTags;
}

export default class NpcCreatePopup extends PureComponent<Props, State> {
  static defaultProps = {
    isVisible: false,
    onClose: () => {},
    onCreate: (_request: NpcCreateRequest) => {},
  };

  state: State = {
    name: "",
    gender: "unknown",
    soul: "",
    tagsInput: "",
    errorMessage: "",
  };

  private resetForm() {
    this.setState({
      name: "",
      gender: "unknown",
      soul: "",
      tagsInput: "",
      errorMessage: "",
    });
  }

  handleNameChange = (event: ChangeEvent<HTMLInputElement>) => {
    this.setState({
      name: event.target.value.slice(0, MAX_NPC_NAME_LENGTH),
      errorMessage: "",
    });
  };

  handleGenderChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    const gender: NpcGender =
      value === "male" ||
      value === "female" ||
      value === "non_binary" ||
      value === "unknown"
        ? value
        : "unknown";
    this.setState({ gender });
  };

  handleSoulChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    this.setState({
      soul: event.target.value.slice(0, MAX_SOUL_LENGTH),
    });
  };

  handleTagsChange = (event: ChangeEvent<HTMLInputElement>) => {
    this.setState({
      tagsInput: event.target.value,
    });
  };

  handleCreate = () => {
    const name = this.state.name.trim();
    if (!name) {
      this.setState({ errorMessage: "姓名不能为空" });
      return;
    }

    const request: NpcCreateRequest = {
      id: buildNpcId(name),
      name,
      gender: this.state.gender,
      soul: this.state.soul.trim().slice(0, MAX_SOUL_LENGTH),
      personaTags: parsePersonaTags(this.state.tagsInput),
    };

    this.props.onCreate(request);
    this.resetForm();
  };

  handleClose = () => {
    this.resetForm();
    this.props.onClose();
  };

  render() {
    const { isVisible } = this.props;
    const parsedTags = parsePersonaTags(this.state.tagsInput);

    return (
      <Popup
        title="NPC 创建"
        isVisible={isVisible}
        onClose={this.handleClose}
        height={420}
        width={460}
        left="calc(50% - 230px)"
        top="18%"
        footerContent={
          <div style={{ marginBottom: 12 }}>
            <Button onClick={this.handleCreate}>创建</Button>
            <Button onClick={this.handleClose}>关闭</Button>
          </div>
        }
      >
        <div style={{ marginTop: 18 }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ marginBottom: 4, color: "#eac26f" }}>姓名</div>
            <input
              type="text"
              value={this.state.name}
              onChange={this.handleNameChange}
              placeholder="例如：Luna"
              style={{
                width: "100%",
                borderRadius: 4,
                border: "1px solid #705941",
                padding: "8px 10px",
                color: "white",
                backgroundColor: "rgba(0, 0, 0, 0.25)",
              }}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ marginBottom: 4, color: "#eac26f" }}>性别</div>
            <select
              value={this.state.gender}
              onChange={this.handleGenderChange}
              style={{
                width: "100%",
                borderRadius: 4,
                border: "1px solid #705941",
                padding: "8px 10px",
                color: "white",
                backgroundColor: "rgba(0, 0, 0, 0.25)",
              }}
            >
              <option value="unknown">未知</option>
              <option value="male">男</option>
              <option value="female">女</option>
              <option value="non_binary">非二元</option>
            </select>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ marginBottom: 4, color: "#eac26f" }}>灵魂设定</div>
            <textarea
              value={this.state.soul}
              onChange={this.handleSoulChange}
              rows={4}
              placeholder="例如：温和、喜欢帮助新人、说话简短。"
              style={{
                width: "100%",
                borderRadius: 4,
                border: "1px solid #705941",
                padding: "8px 10px",
                color: "white",
                backgroundColor: "rgba(0, 0, 0, 0.25)",
                resize: "vertical",
              }}
            />
          </div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ marginBottom: 4, color: "#eac26f" }}>
              标签（逗号分隔）
            </div>
            <input
              type="text"
              value={this.state.tagsInput}
              onChange={this.handleTagsChange}
              placeholder="guide, friendly, villager"
              style={{
                width: "100%",
                borderRadius: 4,
                border: "1px solid #705941",
                padding: "8px 10px",
                color: "white",
                backgroundColor: "rgba(0, 0, 0, 0.25)",
              }}
            />
          </div>

          <div style={{ fontSize: 12, color: "rgba(255, 255, 255, 0.7)" }}>
            将生成 {parsedTags.length} 个标签，创建后会自动广播到所有在线玩家。
          </div>

          {this.state.errorMessage && (
            <div style={{ marginTop: 8, color: "#ffaeae", fontSize: 12 }}>
              {this.state.errorMessage}
            </div>
          )}
        </div>
      </Popup>
    );
  }
}
